import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  AttachedCaptureProtocol,
  CaptureProtocolRepository,
} from '../../application/ports/capture-protocol-repository.ts'
import {
  assertCaptureProtocolIntegrity,
  CAPTURE_PROTOCOL_SCHEMA_VERSION,
  type CaptureProtocol,
  type CaptureRequirement,
  type CaptureScenario,
  type ExpectedTrack,
  type SyncCeiling,
} from '../../domain/capture-protocol.ts'
import {
  assertCaptureProtocolEvaluationIntegrity,
  CAPTURE_PROTOCOL_EVALUATION_SCHEMA_VERSION,
  type CaptureProtocolEvaluation,
  type RequirementFinding,
} from '../../domain/capture-protocol-evaluation.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parse<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${what} is not valid JSON`)
  }
}

function hydrateProtocol(row: {
  protocolId: string
  scenario: string
  version: number
  schemaVersion: string
  title: string
  summary: string
  requirementsJson: string
  expectedTracksJson: string
  bestCeiling: string
  protocolHash: string
  publishedAt: Date
}): Readonly<CaptureProtocol> {
  if (row.schemaVersion !== CAPTURE_PROTOCOL_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored capture protocol ${row.protocolId} carries an unknown schema version`,
    )
  }
  const protocol: CaptureProtocol = {
    schemaVersion: CAPTURE_PROTOCOL_SCHEMA_VERSION,
    protocolId: row.protocolId,
    scenario: row.scenario as CaptureScenario,
    version: row.version,
    title: row.title,
    summary: row.summary,
    requirements: Object.freeze(
      parse<CaptureRequirement[]>(row.requirementsJson, `protocol ${row.protocolId} requirements`),
    ),
    expectedTracks: Object.freeze(
      parse<ExpectedTrack[]>(row.expectedTracksJson, `protocol ${row.protocolId} expected tracks`),
    ),
    bestCeiling: row.bestCeiling as SyncCeiling,
    publishedAt: row.publishedAt.toISOString(),
    protocolHash: row.protocolHash,
  }
  // Rebuilt from columns and re-hashed: a requirement softened in the database
  // fails here rather than lowering a ceiling somewhere downstream.
  return assertCaptureProtocolIntegrity(Object.freeze(protocol))
}

function hydrateEvaluation(row: {
  workspaceId: string
  sessionId: string
  sessionVersion: number
  sessionHash: string
  protocolId: string
  protocolVersion: number
  protocolHash: string
  schemaVersion: string
  findingsJson: string
  lostCapabilitiesJson: string
  attestedRequirementsJson: string
  ceiling: string
  blocksAutoEdit: boolean
  evaluationHash: string
  evaluatedAt: Date
}): Readonly<CaptureProtocolEvaluation> {
  if (row.schemaVersion !== CAPTURE_PROTOCOL_EVALUATION_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored protocol evaluation for ${row.sessionId} carries an unknown schema version`,
    )
  }
  const evaluation: CaptureProtocolEvaluation = {
    schemaVersion: CAPTURE_PROTOCOL_EVALUATION_SCHEMA_VERSION,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sessionVersion: row.sessionVersion,
    sessionHash: row.sessionHash,
    protocolId: row.protocolId,
    protocolVersion: row.protocolVersion,
    protocolHash: row.protocolHash,
    findings: Object.freeze(parse<RequirementFinding[]>(row.findingsJson, 'evaluation findings')),
    lostCapabilities: Object.freeze(
      parse<CaptureProtocolEvaluation['lostCapabilities'][number][]>(row.lostCapabilitiesJson, 'lost capabilities'),
    ),
    ceiling: row.ceiling as SyncCeiling,
    blocksAutoEdit: row.blocksAutoEdit,
    attestedRequirementIds: Object.freeze(
      parse<string[]>(row.attestedRequirementsJson, 'attested requirements'),
    ),
    evaluatedAt: row.evaluatedAt.toISOString(),
    evaluationHash: row.evaluationHash,
  }
  return assertCaptureProtocolEvaluationIntegrity(Object.freeze(evaluation))
}

export class PrismaCaptureProtocolRepository implements CaptureProtocolRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async publish(input: {
    protocol: Readonly<CaptureProtocol>
    createdAt: string
  }): Promise<Readonly<{ protocol: Readonly<CaptureProtocol>; replayed: boolean }>> {
    const { protocol } = input
    try {
      await this.client.v2CaptureProtocol.create({
        data: {
          id: `${protocol.protocolId}:v${protocol.version}`,
          protocolId: protocol.protocolId,
          scenario: protocol.scenario,
          version: protocol.version,
          schemaVersion: protocol.schemaVersion,
          title: protocol.title,
          summary: protocol.summary,
          requirementsJson: JSON.stringify(protocol.requirements),
          expectedTracksJson: JSON.stringify(protocol.expectedTracks),
          requiredCount: protocol.requirements.filter((entry) => entry.level === 'required').length,
          bestCeiling: protocol.bestCeiling,
          protocolHash: protocol.protocolHash,
          publishedAt: new Date(protocol.publishedAt),
          createdAt: new Date(input.createdAt),
        },
      })
      return Object.freeze({ protocol, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.read({ protocolId: protocol.protocolId, version: protocol.version })
      if (stored && stored.protocolHash === protocol.protocolHash) {
        return Object.freeze({ protocol: stored, replayed: true })
      }
      // Republishing different content under the same version would rewrite
      // what every stored evaluation naming that version claims to have been
      // judged against.
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Capture protocol ${protocol.protocolId} v${protocol.version} is already published with different content`,
      )
    }
  }

  async list(): Promise<readonly Readonly<CaptureProtocol>[]> {
    const rows = await this.client.v2CaptureProtocol.findMany({
      orderBy: [{ scenario: 'asc' }, { version: 'desc' }],
    })
    return Object.freeze(rows.map(hydrateProtocol))
  }

  async read(input: { protocolId: string; version?: number }): Promise<Readonly<CaptureProtocol> | null> {
    const row = input.version === undefined
      ? await this.client.v2CaptureProtocol.findFirst({
        where: { protocolId: input.protocolId },
        orderBy: { version: 'desc' },
      })
      : await this.client.v2CaptureProtocol.findFirst({
        where: { protocolId: input.protocolId, version: input.version },
      })
    return row ? hydrateProtocol(row) : null
  }

  async attach(input: {
    workspaceId: string
    sessionId: string
    protocol: Readonly<CaptureProtocol>
    attachedByKind: AttachedCaptureProtocol['attachedByKind']
    attachedById: string
    attachedAt: string
  }): Promise<Readonly<AttachedCaptureProtocol>> {
    const at = new Date(input.attachedAt)
    const data = {
      id: `${input.sessionId}:protocol`,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      protocolId: input.protocol.protocolId,
      protocolVersion: input.protocol.version,
      protocolHash: input.protocol.protocolHash,
      attachedByKind: input.attachedByKind,
      attachedById: input.attachedById,
      attachedAt: at,
      updatedAt: at,
    }
    // Replaceable by design: an operator can realise mid-ingest that this was
    // a podcast, not a multicam. Crucially this writes no CaptureSession
    // version — the recording did not change, only our description of what it
    // was meant to be.
    const row = await this.client.v2CaptureSessionProtocol.upsert({
      where: {
        sessionId_workspaceId: { sessionId: input.sessionId, workspaceId: input.workspaceId },
      },
      create: data,
      update: {
        protocolId: data.protocolId,
        protocolVersion: data.protocolVersion,
        protocolHash: data.protocolHash,
        attachedByKind: data.attachedByKind,
        attachedById: data.attachedById,
        updatedAt: at,
      },
    })
    return Object.freeze({
      sessionId: row.sessionId,
      protocolId: row.protocolId,
      protocolVersion: row.protocolVersion,
      protocolHash: row.protocolHash,
      attachedByKind: row.attachedByKind as AttachedCaptureProtocol['attachedByKind'],
      attachedById: row.attachedById,
      attachedAt: row.attachedAt.toISOString(),
    })
  }

  async readAttachment(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<AttachedCaptureProtocol> | null> {
    const row = await this.client.v2CaptureSessionProtocol.findFirst({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
    })
    if (!row) return null
    return Object.freeze({
      sessionId: row.sessionId,
      protocolId: row.protocolId,
      protocolVersion: row.protocolVersion,
      protocolHash: row.protocolHash,
      attachedByKind: row.attachedByKind as AttachedCaptureProtocol['attachedByKind'],
      attachedById: row.attachedById,
      attachedAt: row.attachedAt.toISOString(),
    })
  }

  async persistEvaluation(input: {
    evaluation: Readonly<CaptureProtocolEvaluation>
    createdAt: string
  }): Promise<Readonly<{ evaluation: Readonly<CaptureProtocolEvaluation>; replayed: boolean }>> {
    const { evaluation } = input
    const unmetRequired = evaluation.findings.filter((finding) =>
      finding.level === 'required'
      && (finding.outcome === 'unmet' || finding.outcome === 'attestation-missing')).length
    const data = {
      id: `${evaluation.sessionId}:v${evaluation.sessionVersion}:${evaluation.protocolId}:v${evaluation.protocolVersion}`,
      workspaceId: evaluation.workspaceId,
      sessionId: evaluation.sessionId,
      sessionVersion: evaluation.sessionVersion,
      sessionHash: evaluation.sessionHash,
      protocolId: evaluation.protocolId,
      protocolVersion: evaluation.protocolVersion,
      protocolHash: evaluation.protocolHash,
      schemaVersion: evaluation.schemaVersion,
      findingsJson: JSON.stringify(evaluation.findings),
      lostCapabilitiesJson: JSON.stringify(evaluation.lostCapabilities),
      attestedRequirementsJson: JSON.stringify(evaluation.attestedRequirementIds),
      ceiling: evaluation.ceiling,
      blocksAutoEdit: evaluation.blocksAutoEdit,
      unmetRequiredCount: unmetRequired,
      evaluationHash: evaluation.evaluationHash,
      evaluatedAt: new Date(evaluation.evaluatedAt),
      createdAt: new Date(input.createdAt),
    }
    // Re-running the same judgement on the same session version converges: the
    // inputs are identical and so is the answer.
    const stored = await this.client.v2CaptureProtocolEvaluation.upsert({
      where: { id: data.id },
      create: data,
      update: data,
      select: { evaluationHash: true },
    })
    return Object.freeze({ evaluation, replayed: stored.evaluationHash === evaluation.evaluationHash })
  }

  async readEvaluation(input: {
    workspaceId: string
    sessionId: string
    sessionVersion: number
    protocolId: string
    protocolVersion: number
  }): Promise<Readonly<CaptureProtocolEvaluation> | null> {
    const row = await this.client.v2CaptureProtocolEvaluation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sessionVersion: input.sessionVersion,
        protocolId: input.protocolId,
        protocolVersion: input.protocolVersion,
      },
    })
    return row ? hydrateEvaluation(row) : null
  }

  async listEvaluations(input: {
    workspaceId: string
    sessionId: string
    limit?: number
  }): Promise<readonly Readonly<CaptureProtocolEvaluation>[]> {
    const rows = await this.client.v2CaptureProtocolEvaluation.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { evaluatedAt: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 100),
    })
    return Object.freeze(rows.map(hydrateEvaluation))
  }
}
