import type {
  ContiguousEvaluationDecision,
  ContiguousEvaluationMomentSource,
  ContiguousEvaluationProvider,
  ContiguousEvaluationSource,
} from '../../application/ports/contiguous-evaluation-provider.ts'
import type {
  ContiguousEvaluationEvidence,
  ContiguousEvaluationEvidenceKind,
} from '../../domain/contiguous-evaluation-evidence.ts'
import type {
  ContiguousQualityDimension,
} from '../../domain/contiguous-extraction.ts'
import { DomainError } from '../../domain/errors.ts'

export const DETERMINISTIC_CONTIGUOUS_EVALUATOR_IDENTITY =
  Object.freeze({
    provider: 'apollo',
    model: 'contiguous-evidence-policy',
    version: '1.0.0',
  })

const REQUIRED_KINDS = [
  'transcript-boundary',
  'transcript-density',
  'rights-integrity',
  'audio-analysis',
  'visual-analysis',
] as const satisfies readonly ContiguousEvaluationEvidenceKind[]

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function score(value: number): number {
  return Math.round(clamp(value) * 1_000_000) / 1_000_000
}

function booleanFact(
  evidence: Readonly<ContiguousEvaluationEvidence>,
  field: string,
): boolean | undefined {
  const value = evidence.facts[field]
  return typeof value === 'boolean' ? value : undefined
}

function numberFact(
  evidence: Readonly<ContiguousEvaluationEvidence>,
  field: string,
): number | undefined {
  const value = evidence.facts[field]
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function evidenceByKind(
  moment: Readonly<ContiguousEvaluationMomentSource>,
  kind: ContiguousEvaluationEvidenceKind,
) {
  const matches = moment.evidence.filter(
    (evidence) => evidence.kind === kind,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function rejection(
  moment: Readonly<ContiguousEvaluationMomentSource>,
  reason:
    | 'NO_SEMANTIC_WINDOW'
    | 'INSUFFICIENT_TRANSCRIPT_EVIDENCE'
    | 'INSUFFICIENT_AUDIO_EVIDENCE'
    | 'INSUFFICIENT_VISUAL_EVIDENCE'
    | 'INTEGRITY_BLOCKED',
): Readonly<ContiguousEvaluationDecision> {
  return Object.freeze({
    status: 'rejected' as const,
    momentId: moment.id,
    reason,
    evidenceRefs: Object.freeze(
      moment.evidence.slice(0, 32).map((evidence) => evidence.id),
    ),
  })
}

function observation(
  value: number,
  evidence: Readonly<ContiguousEvaluationEvidence>,
) {
  return Object.freeze({
    value: score(value),
    evidenceRefs: Object.freeze([evidence.id]),
  })
}

function objectiveTags(input: {
  topic: string
  selfContained: number
  density: number
  integrity: number
  audio: number
  visual: number
}): readonly string[] {
  const tags: string[] = []
  if (input.selfContained >= 0.6 && input.visual >= 0.4) {
    tags.push('discovery')
  }
  if (input.selfContained >= 0.55 && input.density >= 0.35) {
    tags.push('awareness')
  }
  if (input.integrity >= 1 && input.audio >= 0.4) {
    tags.push('warming')
  }
  const topic = input.topic.toLocaleLowerCase('pt-BR')
  const conversionRules = Object.freeze([
    [
      'lead-generation',
      /\b(cadastr|formul[áa]rio|inscri[cç][aã]o|contato|lead)\w*/u,
    ],
    [
      'sale',
      /\b(compr|oferta|pre[cç]o|valor|vend)\w*/u,
    ],
    [
      'whatsapp',
      /\b(whatsapp|mensagem|conversa|fale conosco)\b/u,
    ],
    [
      'booking',
      /\b(agend|hor[áa]rio|consulta|reuni[aã]o)\w*/u,
    ],
    [
      'download',
      /\b(baix|download|material|guia|e-?book)\w*/u,
    ],
  ] as const)
  for (const [objective, pattern] of conversionRules) {
    if (
      pattern.test(topic) &&
      input.integrity >= 1 &&
      input.selfContained >= 0.55
    ) {
      tags.push(objective)
    }
  }
  return Object.freeze(tags)
}

function evaluateMoment(
  moment: Readonly<ContiguousEvaluationMomentSource>,
): Readonly<ContiguousEvaluationDecision> {
  const evidence = Object.fromEntries(
    REQUIRED_KINDS.map((kind) => [
      kind,
      evidenceByKind(moment, kind),
    ]),
  ) as Record<
    ContiguousEvaluationEvidenceKind,
    Readonly<ContiguousEvaluationEvidence> | undefined
  >
  const boundary = evidence['transcript-boundary']
  const densityEvidence = evidence['transcript-density']
  if (!boundary || !densityEvidence) {
    return rejection(
      moment,
      'INSUFFICIENT_TRANSCRIPT_EVIDENCE',
    )
  }
  const rights = evidence['rights-integrity']
  if (
    !rights ||
    booleanFact(rights, 'rightsApproved') !== true ||
    (
      booleanFact(rights, 'consentApproved') !== true &&
      booleanFact(rights, 'consentNotRequired') !== true
    )
  ) {
    return rejection(moment, 'INTEGRITY_BLOCKED')
  }
  const audioEvidence = evidence['audio-analysis']
  if (
    !audioEvidence ||
    booleanFact(audioEvidence, 'audibleSignal') !== true ||
    booleanFact(
      audioEvidence,
      'sourceChecksumVerified',
    ) !== true
  ) {
    return rejection(moment, 'INSUFFICIENT_AUDIO_EVIDENCE')
  }
  const visualEvidence = evidence['visual-analysis']
  if (
    !visualEvidence ||
    booleanFact(
      visualEvidence,
      'sourceChecksumVerified',
    ) !== true ||
    (numberFact(visualEvidence, 'sampledFrameCount') ?? 0) < 1 ||
    (numberFact(visualEvidence, 'blackRatio') ?? 1) >= 0.98
  ) {
    return rejection(moment, 'INSUFFICIENT_VISUAL_EVIDENCE')
  }

  const alignedStart =
    booleanFact(boundary, 'alignedStart') === true ? 1 : 0
  const alignedEnd =
    booleanFact(boundary, 'alignedEnd') === true ? 1 : 0
  const startsClean =
    booleanFact(boundary, 'startsWithCapitalOrNumber') === true
      ? 1
      : 0
  const endsClean =
    booleanFact(boundary, 'endsWithTerminalPunctuation') === true
      ? 1
      : 0
  const preserved =
    booleanFact(boundary, 'evidencePreserved') === true ? 1 : 0
  const maximumGapMs =
    numberFact(boundary, 'maximumInternalGapMs') ?? 60_000
  const selfContained = score(
    alignedStart * 0.2 +
    alignedEnd * 0.2 +
    startsClean * 0.15 +
    endsClean * 0.15 +
    preserved * 0.2 +
    clamp(1 - maximumGapMs / 5_000) * 0.1,
  )

  const wordsPerMinute =
    numberFact(densityEvidence, 'wordsPerMinute') ?? 0
  const coverage =
    numberFact(densityEvidence, 'speechCoverageRatio') ?? 0
  const wordCount =
    numberFact(densityEvidence, 'wordCount') ?? 0
  const density = score(
    clamp(1 - Math.abs(wordsPerMinute - 145) / 145) * 0.5 +
    clamp(coverage / 0.75) * 0.35 +
    clamp(wordCount / 80) * 0.15,
  )

  const integrity = 1
  const integratedLufs =
    numberFact(audioEvidence, 'integratedLufs') ?? -120
  const silenceRatio =
    numberFact(audioEvidence, 'silenceRatio') ?? 1
  const clippingRisk =
    booleanFact(audioEvidence, 'clippingRisk') !== false
  const audio = score(
    clamp(1 - Math.abs(integratedLufs + 16) / 30) * 0.5 +
    clamp(1 - silenceRatio) * 0.3 +
    (clippingRisk ? 0 : 1) * 0.2,
  )

  const averageLuma =
    numberFact(visualEvidence, 'averageLuma') ?? 0
  const blackRatio =
    numberFact(visualEvidence, 'blackRatio') ?? 1
  const freezeRatio =
    numberFact(visualEvidence, 'freezeRatio') ?? 1
  const broadcastViolation =
    numberFact(
      visualEvidence,
      'broadcastRangeViolationRatio',
    ) ?? 1
  const visual = score(
    clamp(1 - Math.abs(averageLuma - 0.5) / 0.5) * 0.35 +
    clamp(1 - blackRatio) * 0.25 +
    clamp(1 - freezeRatio) * 0.2 +
    clamp(1 - broadcastViolation) * 0.2,
  )

  const scores = Object.freeze({
    selfContained: observation(selfContained, boundary),
    density: observation(density, densityEvidence),
    integrity: observation(integrity, rights),
    audio: observation(audio, audioEvidence),
    visual: observation(visual, visualEvidence),
  }) satisfies Readonly<Record<
    ContiguousQualityDimension,
    ReturnType<typeof observation>
  >>
  const tags = objectiveTags({
    topic: moment.topic,
    selfContained,
    density,
    integrity,
    audio,
    visual,
  })
  if (tags.length === 0) {
    return rejection(moment, 'NO_SEMANTIC_WINDOW')
  }
  return Object.freeze({
    status: 'evaluated' as const,
    momentId: moment.id,
    objectiveTags: tags,
    semanticRangeMs: Object.freeze([
      Math.min(moment.recommendedRangeMs[0], boundary.rangeMs[0]),
      Math.max(moment.recommendedRangeMs[1], boundary.rangeMs[1]),
    ]) as readonly [number, number],
    scores,
  })
}

export class DeterministicContiguousEvaluationProvider
implements ContiguousEvaluationProvider {
  readonly identity =
    DETERMINISTIC_CONTIGUOUS_EVALUATOR_IDENTITY

  async evaluate(
    source: Readonly<ContiguousEvaluationSource>,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evaluation was aborted',
      )
    }
    return Object.freeze(source.moments.map((moment) => {
      if (signal.aborted) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Contiguous evaluation was aborted',
        )
      }
      return evaluateMoment(moment)
    }))
  }
}
