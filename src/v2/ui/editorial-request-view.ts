/**
 * ADR-160 F7/F8. The pure half of the screen that shows how the Apollo read a briefing.
 *
 * Nothing here touches the network or the DOM. It turns the editorial-request answer (`GET /v1/projects/{id}/editorial-request`, the
 * batch twin, and the result of `revise-editorial-request`) into plain Portuguese: what was understood (always with the words of the
 * briefing it stands on), what the Apollo does not do yet, what it still needs to ask, and whether the Director is blocked. It never
 * suggests a value: it only reports what the request said and what is missing.
 */

import { classifyCommandFailure, type CommandFailure } from './issue-override-view.ts'
import { describeDirectiveWords } from '../domain/editorial-request-texts.ts'

export interface ViewExcerpt { start: number; end: number; text: string }
export interface ViewDirective { id: string; kind: string; value: string; param?: string | number; excerpt?: ViewExcerpt }
export interface ViewUnsupported { id: string; source: 'interpretation' | 'directive'; reason: 'outside-vocabulary' | 'not-executable'; summary: string; excerpt: string | null }
/** One closed answer of a question: choosing it is the owner's answer, and it becomes the directive of the same revision. */
export interface ViewChoice { id: string; label: string; directive: Pick<ViewDirective, 'kind' | 'value' | 'param'> }
export interface ViewQuestion { id: string; question: string; excerpt: string | null; choices?: readonly ViewChoice[] }
export interface ViewInterpretationQuestion { id: string; question: string; status: 'open' | 'answered'; answer?: string; excerpt?: ViewExcerpt; choices?: readonly ViewChoice[] }
export interface ViewCoverageItem { topic: 'audience' | 'offer' | 'tone'; excerpt: ViewExcerpt }

export interface EditorialRequestData {
  state: 'no-briefing' | 'awaiting-interpretation' | 'interpreted'
  request: { briefing?: { text: string; sha256: string }; directives: readonly ViewDirective[]; requestHash: string }
  interpretation: null | {
    directives: readonly ViewDirective[]
    questions: readonly ViewInterpretationQuestion[]
    coverage?: readonly ViewCoverageItem[]
  }
  unsupported: readonly ViewUnsupported[]
  openQuestions: readonly ViewQuestion[]
  blocksDirector: boolean
}

/** The plain words for one directive, with its parameter: "Abertura: Proteger os primeiros segundos (3 s)". The words are the catalog of ADR-160 (one table). */
export function describeDirective(directive: Readonly<Pick<ViewDirective, 'kind' | 'value' | 'param'>>): { label: string; text: string } {
  return describeDirectiveWords(directive.kind, directive.value, directive.param)
}

export const COVERAGE_LABELS: Readonly<Record<ViewCoverageItem['topic'], string>> = Object.freeze({ audience: 'Público', offer: 'Oferta', tone: 'Tom' })

export const UNSUPPORTED_REASON_LABELS: Readonly<Record<ViewUnsupported['reason'], string>> = Object.freeze({
  'outside-vocabulary': 'O Apollo não sabe fazer este pedido.',
  'not-executable': 'O Apollo entendeu, mas ainda não consegue executar este pedido.',
})

export type RequestBlock =
  | { kind: 'free'; message: string }
  | { kind: 'no-briefing'; message: string }
  | { kind: 'unread'; message: string }
  | { kind: 'questions'; message: string; count: number }
  | { kind: 'unsupported'; message: string; count: number }

/** Why the Director is blocked (or that it is not), in the order the owner has to fix them: read, answer, change. */
export function describeRequestBlock(data: Readonly<EditorialRequestData>): RequestBlock {
  if (data.state === 'awaiting-interpretation') {
    return { kind: 'unread', message: 'O Diretor está bloqueado: o Apollo ainda não leu o seu briefing.' }
  }
  const open = data.openQuestions.length
  if (open > 0) {
    return {
      kind: 'questions', count: open,
      message: `O Diretor está bloqueado até você responder ${open === 1 ? 'a pergunta' : `as ${open} perguntas`} abaixo.`,
    }
  }
  const unsupported = data.unsupported.length
  if (unsupported > 0) {
    return {
      kind: 'unsupported', count: unsupported,
      message: `O Diretor está bloqueado: ${unsupported === 1 ? 'um pedido do briefing não pode' : `${unsupported} pedidos do briefing não podem`} ser feito${unsupported === 1 ? '' : 's'} pelo Apollo. Mude o briefing para continuar.`,
    }
  }
  if (data.state === 'no-briefing') {
    return { kind: 'no-briefing', message: 'Não há briefing escrito. O Apollo só fará o que for pedido em outros campos.' }
  }
  return { kind: 'free', message: 'Briefing lido. Nenhuma pergunta aberta: o Diretor está liberado.' }
}

/**
 * The answers the owner gave, as the body of `revise-editorial-request`. A question with closed answers is answered by choosing one (`choiceId`, and the
 * draft holds the choice); any other question is answered in the owner's words. An answer left blank, or a choice that is not one of the offered, is not sent.
 */
export function buildAnswersBody(drafts: Readonly<Record<string, string>>, openQuestions: readonly Pick<ViewQuestion, 'id' | 'choices'>[]): { answers: ({ questionId: string; answer: string } | { questionId: string; choiceId: string })[] } | null {
  type Answer = { questionId: string; answer: string } | { questionId: string; choiceId: string }
  const answers = openQuestions.flatMap((question): Answer[] => {
    const draft = (drafts[question.id] ?? '').replace(/\s+/gu, ' ').trim()
    if (draft.length === 0) return []
    if (question.choices) return question.choices.some((choice) => choice.id === draft) ? [{ questionId: question.id, choiceId: draft }] : []
    return [{ questionId: question.id, answer: draft }]
  })
  return answers.length > 0 ? { answers } : null
}

/** The words of a closed answer, in plain Portuguese: what the choice makes the Apollo do. */
export function describeChoice(choice: Readonly<ViewChoice>): string {
  return describeDirective(choice.directive).text
}

export const ANSWER_MAX_LENGTH = 500

/** What a failed read or revision of the request tells the owner. */
export function describeRequestFailure(status: number, payload: { error?: { code?: string; message?: string; requestId?: string; details?: { reason?: string } } } | null): CommandFailure {
  const reason = payload?.error?.details?.reason ?? null
  if (payload?.error?.code === 'PRECONDITION_REQUIRED' && reason === 'editorial-request-needs-output') {
    return {
      kind: 'refused', status, code: 'PRECONDITION_REQUIRED', requestId: payload?.error?.requestId ?? null,
      message: 'Este projeto ainda não tem um vídeo e uma saída. Só então o pedido pode ser respondido ou mudado. O que o Apollo entendeu já está salvo.',
    }
  }
  if (payload?.error?.code === 'PRECONDITION_REQUIRED' && reason === 'brief-interpreter-unavailable') {
    return {
      kind: 'unavailable', status, code: 'PRECONDITION_REQUIRED', requestId: payload?.error?.requestId ?? null,
      message: 'Este ambiente não tem o leitor de briefing ligado. O texto ficou salvo, mas o Diretor só começa depois que o briefing for lido.',
    }
  }
  // The Command that reads a briefing is made on a Version that already has an output and a montage; a project just created has neither.
  // The refusal says so in plain words (the text stays saved) instead of the generic "changed in another session".
  const code = payload?.error?.code ?? null
  if (status === 409 && code !== null && code !== 'VERSION_CONFLICT' && code !== 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
    return {
      kind: 'refused', status, code, requestId: payload?.error?.requestId ?? null,
      message: 'Não foi possível ler o briefing agora. Isso costuma acontecer enquanto o projeto ainda não tem um vídeo e uma saída. O texto ficou salvo, e a leitura pode ser feita depois, na página do projeto.',
    }
  }
  return classifyCommandFailure(status, payload)
}
