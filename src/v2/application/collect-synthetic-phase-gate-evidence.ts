import type {
  SyntheticPhaseGateCriterionEvidenceInput,
  SyntheticPhaseGateEvidenceReferenceInput,
} from '../domain/synthetic-phase-gate.ts'
import type {
  SyntheticPhaseGateEvidenceReader,
  SyntheticPhaseGateEvidenceSources,
} from './ports/synthetic-phase-gate-evidence-reader.ts'
import type {
  SyntheticPhaseGateEvidenceContext,
  SyntheticPhaseGateEvidenceQuery,
} from './ports/synthetic-phase-gate-repository.ts'

function referenceOrder(
  left: Readonly<SyntheticPhaseGateEvidenceReferenceInput>,
  right: Readonly<SyntheticPhaseGateEvidenceReferenceInput>,
) {
  return left.type.localeCompare(right.type) ||
    left.id.localeCompare(right.id) ||
    left.hash.localeCompare(right.hash)
}

function references(
  values: readonly Readonly<SyntheticPhaseGateEvidenceReferenceInput>[],
) {
  const unique = new Map(values.map((value) => [
    `${value.type}:${value.id}:${value.hash}`,
    value,
  ]))
  return Object.freeze([...unique.values()].sort(referenceOrder))
}

function firstByReference<T extends { references: readonly SyntheticPhaseGateEvidenceReferenceInput[] }>(
  values: readonly Readonly<T>[],
) {
  return [...values].sort((left, right) => {
    const leftKey = left.references.map(({ type, id, hash }) => `${type}:${id}:${hash}`).sort().join('|')
    const rightKey = right.references.map(({ type, id, hash }) => `${type}:${id}:${hash}`).sort().join('|')
    return leftKey.localeCompare(rightKey)
  })[0]
}

function containsReferenceTypes(
  values: readonly Readonly<SyntheticPhaseGateEvidenceReferenceInput>[],
  required: Readonly<Record<string, number>>,
) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value.type, (counts.get(value.type) ?? 0) + 1)
  return Object.entries(required).every(([type, count]) => (counts.get(type) ?? 0) >= count)
}

export function collectSyntheticPhaseGateEvidence(
  sources: Readonly<SyntheticPhaseGateEvidenceSources>,
): readonly Readonly<SyntheticPhaseGateCriterionEvidenceInput>[] {
  const live = sources.providerExecutions.filter((entry) => entry.runtimeClass === 'live')
  const elevenLabs = firstByReference(live.filter((entry) =>
    entry.kind === 'elevenlabs-audio-alignment' && containsReferenceTypes(entry.references, {
      'provider-job': 1,
      'provider-result-artifact': 1,
      'alignment-artifact': 1,
    })))
  const generatedAvatar = firstByReference(live.filter((entry) =>
    entry.kind === 'heygen-generated-audio-avatar' && containsReferenceTypes(entry.references, {
      'provider-job': 2,
      'provider-result-artifact': 2,
      'alignment-artifact': 1,
      'synthetic-audio-master': 1,
    })))
  const readyAvatar = firstByReference(live.filter((entry) =>
    entry.kind === 'heygen-ready-audio-avatar' && containsReferenceTypes(entry.references, {
      'provider-job': 1,
      'provider-result-artifact': 1,
      'synthetic-audio-master': 1,
    })))
  const f3Gate001 = [
    ...(elevenLabs ? [{
      code: 'elevenlabs-audio-alignment-live' as const,
      passed: elevenLabs.passed,
      references: references(elevenLabs.references),
    }] : []),
    ...(generatedAvatar ? [{
      code: 'heygen-generated-audio-avatar-live' as const,
      passed: generatedAvatar.passed,
      references: references(generatedAvatar.references),
    }] : []),
    ...(readyAvatar ? [{
      code: 'heygen-ready-audio-avatar-live' as const,
      passed: readyAvatar.passed,
      references: references(readyAvatar.references),
    }] : []),
  ]

  const catalogue = [...sources.catalogues]
    .filter((entry) => entry.segments.length > 0)
    .sort((left, right) => left.master.id.localeCompare(right.master.id))[0]
  const reuse = [...sources.reuses]
    .filter((entry) =>
      entry.sourceProjectId !== entry.consumerProjectId &&
      entry.consumedByProduction)
    .sort((left, right) => left.decision.id.localeCompare(right.decision.id))[0]
  const f3Gate002 = [
    ...(catalogue ? [{
      code: 'approved-blocks-catalogued' as const,
      passed: catalogue.currentAuthorityValid,
      references: references([catalogue.master, ...catalogue.segments.slice(0, 15)]),
    }] : []),
    ...(reuse ? [{
      code: 'cross-project-reuse-with-zero-provider-work' as const,
      passed: reuse.providerWorkCount === 0,
      references: references([reuse.decision, reuse.master, reuse.consumerProject]),
    }] : []),
  ]

  const transformation = [...sources.transformations]
    .filter((entry) => entry.rejectedReport || entry.approvedResult)
    .sort((left, right) => left.ledger.id.localeCompare(right.ledger.id))[0]
  const f3Gate003 = [
    ...(transformation?.rejectedReport ? [{
      code: 'transformation-rejected-before-fallback' as const,
      passed: transformation.rejectedBeforeFallback,
      references: references([transformation.ledger, transformation.rejectedReport]),
    }] : []),
    ...(transformation?.approvedResult ? [{
      code: 'fallback-result-approved' as const,
      passed: transformation.fallbackApproved,
      references: references([transformation.ledger, transformation.approvedResult]),
    }] : []),
  ]

  const swap = [...sources.swaps]
    .sort((left, right) => left.buildAttestation.id.localeCompare(right.buildAttestation.id))[0]
  const f3Gate004 = swap ? [{
    code: 'provider-swap-keeps-plan-and-renderer-contracts' as const,
    passed: swap.runtimeIdentityMatches &&
      swap.assetsMatch &&
      swap.propsHashMatches &&
      swap.providerNeutral,
    references: references([swap.editPlan, swap.renderManifest, swap.buildAttestation]),
  }] : []

  return Object.freeze([
    ...(f3Gate001.length > 0 ? [{ criterion: 'F3-GATE-001' as const, checks: Object.freeze(f3Gate001) }] : []),
    ...(f3Gate002.length > 0 ? [{ criterion: 'F3-GATE-002' as const, checks: Object.freeze(f3Gate002) }] : []),
    ...(f3Gate003.length > 0 ? [{ criterion: 'F3-GATE-003' as const, checks: Object.freeze(f3Gate003) }] : []),
    ...(f3Gate004.length > 0 ? [{ criterion: 'F3-GATE-004' as const, checks: Object.freeze(f3Gate004) }] : []),
  ])
}

export function createSyntheticPhaseGateEvidenceCollector(dependencies: {
  reader: SyntheticPhaseGateEvidenceReader
}) {
  return async function collect(
    input: Readonly<SyntheticPhaseGateEvidenceQuery>,
  ): Promise<Readonly<SyntheticPhaseGateEvidenceContext> | null> {
    const sources = await dependencies.reader.read(input)
    if (!sources) return null
    return Object.freeze({
      projectVersionId: sources.projectVersionId,
      projectVersionHash: sources.projectVersionHash,
      evidence: collectSyntheticPhaseGateEvidence(sources),
    })
  }
}
