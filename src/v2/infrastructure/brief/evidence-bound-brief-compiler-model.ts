import {
  BRIEF_COMPILER_PROMPT_VERSION,
  COMPILED_BRIEF_FIELDS,
  briefCompilerService,
  type BriefCompilerGeneration,
  type BriefCompilerModel,
  type BriefConflict,
  type BriefEvidenceSpan,
  type CompiledBriefField,
  type CompiledBriefFields,
} from '../../application/compile-brief.ts'
import { assertDomain } from '../../domain/errors.ts'

const LABELS: Readonly<Record<string, CompiledBriefField>> = Object.freeze({
  público: 'audience', publico: 'audience', audiência: 'audience', audiencia: 'audience', persona: 'audience',
  oferta: 'offer', produto: 'offer', serviço: 'offer', servico: 'offer',
  restrição: 'constraints', restricao: 'constraints', restrições: 'constraints', restricoes: 'constraints',
  'deve usar': 'mustUse', incluir: 'mustUse', obrigatório: 'mustUse', obrigatorio: 'mustUse',
  evitar: 'avoid', 'não usar': 'avoid', 'nao usar': 'avoid', proibido: 'avoid',
  tom: 'tone', estilo: 'tone', linguagem: 'tone',
  sucesso: 'successCriteria', meta: 'successCriteria', critério: 'successCriteria', criterio: 'successCriteria',
})

const LABEL_PATTERN = Object.keys(LABELS)
  .sort((left, right) => right.length - left.length)
  .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')
const LABELED_VALUE = new RegExp(
  `(?:^|[.;\\n]\\s*)(${LABEL_PATTERN})\\s*:\\s*(.+?)(?=(?:[.;\\n]\\s*(?:${LABEL_PATTERN})\\s*:)|$)`,
  'giu',
)

function normalized(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function emptyFields(): Record<CompiledBriefField, string[]> {
  return {
    audience: [], offer: [], constraints: [], mustUse: [], avoid: [], tone: [], successCriteria: [],
  }
}

function addUnique(target: string[], value: string): number {
  const key = normalized(value)
  const existing = target.findIndex((item) => normalized(item) === key)
  if (existing >= 0) return existing
  target.push(value)
  return target.length - 1
}

export class EvidenceBoundBriefCompilerModel implements BriefCompilerModel {
  readonly id = 'apollo-evidence-bound-brief-compiler'
  readonly version = '1.0.0'

  async generate(input: {
    promptVersion: string
    schemaVersion: number
    text: string
  }): Promise<BriefCompilerGeneration> {
    assertDomain(input.promptVersion === BRIEF_COMPILER_PROMPT_VERSION, 'INVALID_ARGUMENT', 'Unsupported brief compiler prompt version')
    assertDomain(input.schemaVersion === 1, 'INVALID_ARGUMENT', 'Unsupported brief compiler schema version')
    const fields = emptyFields()
    const evidence: BriefEvidenceSpan[] = []
    for (const match of input.text.matchAll(LABELED_VALUE)) {
      const label = match[1]!.toLocaleLowerCase('pt-BR')
      const field = LABELS[label]
      if (!field) continue
      const raw = match[2]!
      const leading = raw.length - raw.trimStart().length
      const value = raw.trim().replace(/[.;]+$/u, '').trim()
      if (!value) continue
      const rawStart = match.index! + match[0].lastIndexOf(raw)
      const start = rawStart + leading
      const end = start + value.length
      addUnique(fields[field], value)
      evidence.push({ field, start, end, quote: input.text.slice(start, end), confidence: 0.98 })
    }

    const conflicts: BriefConflict[] = []
    const tones = fields.tone.map(normalized)
    const formal = tones.some((value) => /\bformal\b/u.test(value) && !/\binformal\b/u.test(value))
    const informal = tones.some((value) => /\binformal\b/u.test(value))
    if (formal && informal) {
      conflicts.push({
        code: 'contradiction',
        message: 'Brief requests both formal and informal tone.',
        material: true,
        evidence: evidence.map((span, index) => span.field === 'tone' ? index : -1).filter((index) => index >= 0),
      })
    }
    const mustUse = new Map(fields.mustUse.map((item) => [normalized(item), item]))
    for (const avoided of fields.avoid) {
      if (mustUse.has(normalized(avoided))) {
        conflicts.push({
          code: 'contradiction',
          message: `Brief both requires and avoids: ${avoided}`,
          material: true,
          evidence: evidence.map((span, index) =>
            span.field === 'mustUse' || span.field === 'avoid' ? index : -1).filter((index) => index >= 0),
        })
      }
    }
    const unsupportedClaim = /\b(garantid[oa]s?|resultado garantido|sem risco)\b/iu.test(input.text)
    if (unsupportedClaim) {
      conflicts.push({
        code: 'unsupported-claim',
        message: 'Brief contains an outcome claim that requires external evidence.',
        material: true,
        evidence: evidence.map((span, index) => span.field === 'offer' ? index : -1).filter((index) => index >= 0),
      })
    }

    const assumptions = COMPILED_BRIEF_FIELDS
      .filter((field) => fields[field].length === 0)
      .map((field) => `${field}-not-specified`)
    return {
      fields: fields as unknown as CompiledBriefFields,
      evidence,
      conflicts,
      assumptions,
    }
  }
}

export function createEvidenceBoundBriefCompiler(input?: {
  guardrails?: readonly string[]
}) {
  return briefCompilerService({
    model: new EvidenceBoundBriefCompilerModel(),
    ...(input?.guardrails ? { guardrails: input.guardrails } : {}),
  })
}
