/**
 * ADR-160 F7/F8. The pure half of the screen that shows how the Apollo read a briefing.
 *
 * Nothing here touches the network or the DOM. It turns the editorial-request answer (`GET /v1/projects/{id}/editorial-request`, the
 * batch twin, and the result of `revise-editorial-request`) into plain Portuguese: what was understood (always with the words of the
 * briefing it stands on), what the Apollo does not do yet, what it still needs to ask, and whether the Director is blocked. It never
 * suggests a value: it only reports what the request said and what is missing.
 */

import { SUBTITLE_PRESET_LABELS, classifyCommandFailure, type CommandFailure } from './issue-override-view.ts'

export interface ViewExcerpt { start: number; end: number; text: string }
export interface ViewDirective { id: string; kind: string; value: string; param?: string | number; excerpt?: ViewExcerpt }
export interface ViewUnsupported { id: string; source: 'interpretation' | 'directive'; reason: 'outside-vocabulary' | 'not-executable'; summary: string; excerpt: string | null }
export interface ViewQuestion { id: string; question: string; excerpt: string | null }
export interface ViewInterpretationQuestion { id: string; question: string; status: 'open' | 'answered'; answer?: string; excerpt?: ViewExcerpt }
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

const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  movement: 'Movimento de câmera',
  opening: 'Abertura',
  structure: 'Ordem do vídeo',
  cta: 'Chamada para ação',
  layout: 'Enquadramento',
  'caption-language': 'Idioma das legendas',
  'caption-style': 'Estilo das legendas',
  keep: 'Manter',
  avoid: 'Evitar',
})

const VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  movement: { none: 'sem movimento', 'punch-in': 'aproximação brusca', 'zoom-in': 'zoom de aproximação', 'zoom-out': 'zoom de afastamento', pan: 'panorâmica', tilt: 'inclinação', parallax: 'paralaxe' },
  opening: { none: 'sem trecho de abertura protegido', 'protect-first-sentence': 'proteger a primeira frase', 'protect-seconds': 'proteger os primeiros segundos' },
  structure: { 'source-order': 'manter a ordem da gravação', 'hook-first': 'começar pelo gancho' },
  cta: {
    none: 'sem chamada', 'verbal-only': 'só falada', 'overlay-closing': 'escrita no fechamento', 'overlay-at-spoken-cta': 'escrita junto da fala',
    'overlay-whole-video': 'escrita no vídeo todo', 'overlay-from-seconds': 'escrita a partir de um segundo',
  },
  layout: { 'source-native': 'formato da gravação', 'fit-with-backdrop': 'vídeo inteiro sobre um fundo', 'fill-crop': 'preencher a tela cortando' },
})

/** The plain words for one directive, with its parameter: "Abertura: proteger os primeiros 3 segundos". */
export function describeDirective(directive: Readonly<Pick<ViewDirective, 'kind' | 'value' | 'param'>>): { label: string; text: string } {
  const label = KIND_LABELS[directive.kind] ?? directive.kind
  const param = directive.param
  let text: string
  if (directive.kind === 'caption-language') text = String(param ?? '')
  else if (directive.kind === 'caption-style') text = SUBTITLE_PRESET_LABELS[directive.value] ?? directive.value
  else if (directive.kind === 'keep' || directive.kind === 'avoid') text = String(param ?? '')
  else {
    const base = VALUE_LABELS[directive.kind]?.[directive.value] ?? directive.value
    text = typeof param === 'number' ? `${base} (${param} s)` : base
  }
  return { label, text }
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

/** The answers the owner filled in, as the body of `revise-editorial-request`: blank answers are not sent. */
export function buildAnswersBody(drafts: Readonly<Record<string, string>>, openQuestionIds: readonly string[]): { answers: { questionId: string; answer: string }[] } | null {
  const answers = openQuestionIds
    .map((questionId) => ({ questionId, answer: (drafts[questionId] ?? '').replace(/\s+/gu, ' ').trim() }))
    .filter((item) => item.answer.length > 0)
  return answers.length > 0 ? { answers } : null
}

export const ANSWER_MAX_LENGTH = 500

/** What a failed read or revision of the request tells the owner. */
export function describeRequestFailure(status: number, payload: { error?: { code?: string; message?: string; requestId?: string; details?: { reason?: string } } } | null): CommandFailure {
  const reason = payload?.error?.details?.reason ?? null
  if (payload?.error?.code === 'PRECONDITION_REQUIRED' && reason === 'brief-interpreter-unavailable') {
    return {
      kind: 'unavailable', status, code: 'PRECONDITION_REQUIRED', requestId: payload?.error?.requestId ?? null,
      message: 'Este ambiente não tem o leitor de briefing ligado. O texto ficou salvo, mas o Diretor só começa depois que o briefing for lido.',
    }
  }
  return classifyCommandFailure(status, payload)
}
