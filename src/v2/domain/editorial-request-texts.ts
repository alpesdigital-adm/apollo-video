/**
 * ADR-160. The words the owner reads for every code of the editorial request, in plain Portuguese.
 *
 * The API keeps returning the CODES (`layout`, `fit-with-backdrop`...): they are the contract. What the owner sees on a screen, and what the
 * Apollo writes into the questions, the choices and the unsupported items it generates, comes from here, so there is one catalog and no code
 * name ever reaches a person. A value the Apollo cannot execute yet says so in its own words ("o Apollo ainda não aplica zoom"): the owner
 * learns it before asking, not after a refusal.
 *
 * The module imports nothing: the screens, the application services and the tests read the same table.
 * The test `ADR-160: no question, choice or unsupported item the Apollo writes carries a code…` in `tests/v2/briefing-screens.test.mjs` fails when a code of the vocabulary has no words here.
 */

export const DIRECTIVE_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
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

export const CAPTION_STYLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  kinetic: 'Cinético', 'karaoke-box': 'Karaokê com caixa', 'karaoke-pill': 'Karaokê em pílula', 'caps-stroke': 'Maiúsculas com contorno', 'clean-color': 'Limpo com cor',
})

export const DIRECTIVE_VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  movement: Object.freeze({
    none: 'Sem movimento de câmera',
    'punch-in': 'Aproximação brusca (o Apollo ainda não aplica esse movimento)',
    'zoom-in': 'Zoom (o Apollo ainda não aplica zoom)',
    'zoom-out': 'Zoom de afastamento (o Apollo ainda não aplica zoom)',
    pan: 'Panorâmica (o Apollo ainda não aplica esse movimento)',
    tilt: 'Inclinação (o Apollo ainda não aplica esse movimento)',
    parallax: 'Paralaxe (o Apollo ainda não aplica esse efeito)',
  }),
  opening: Object.freeze({
    none: 'Sem trecho de abertura protegido',
    'protect-first-sentence': 'Proteger a primeira frase',
    'protect-seconds': 'Proteger os primeiros segundos',
  }),
  structure: Object.freeze({
    'source-order': 'Manter a ordem da gravação',
    'hook-first': 'Começar pelo gancho (o Apollo ainda não reordena o vídeo)',
  }),
  cta: Object.freeze({
    none: 'Sem chamada para ação',
    'verbal-only': 'Chamada só falada',
    'overlay-closing': 'Chamada escrita no fechamento',
    'overlay-at-spoken-cta': 'Chamada escrita junto da fala',
    'overlay-whole-video': 'Chamada escrita no vídeo todo',
    'overlay-from-seconds': 'Chamada escrita a partir de um segundo',
  }),
  layout: Object.freeze({
    'source-native': 'Manter o enquadramento da gravação',
    'fit-with-backdrop': 'Encaixar a imagem inteira com fundo',
    'fill-crop': 'Preencher a tela cortando a imagem (o Apollo ainda não faz esse corte)',
  }),
  'caption-language': Object.freeze({ set: 'Idioma das legendas' }),
})

export interface DirectiveWords { label: string; text: string }

/** The words for one directive, with its parameter: `Abertura` / `Proteger os primeiros segundos (3 s)`. A code the catalog does not know is shown as it is. */
export function describeDirectiveWords(kind: string, value: string, param?: string | number | null): DirectiveWords {
  const label = DIRECTIVE_KIND_LABELS[kind] ?? kind
  if (kind === 'caption-language') return { label, text: String(param ?? '') }
  if (kind === 'caption-style') return { label, text: CAPTION_STYLE_LABELS[value] ?? value }
  if (kind === 'keep' || kind === 'avoid') return { label, text: String(param ?? '') }
  const base = DIRECTIVE_VALUE_LABELS[kind]?.[value] ?? value
  return { label, text: typeof param === 'number' ? `${base} (${param} s)` : base }
}

/** "Enquadramento: Manter o enquadramento da gravação": the whole directive in one line. */
export function describeDirectiveLine(kind: string, value: string, param?: string | number | null): string {
  const { label, text } = describeDirectiveWords(kind, value, param)
  return text === '' ? label : `${label}: ${text}`
}

// ---- The sentences the Apollo itself writes when it reads a briefing. ----

/** The briefing says more than one thing about one kind of decision. */
export function ambiguousDirectiveQuestion(kind: string, options: readonly string[]): string {
  const label = (DIRECTIVE_KIND_LABELS[kind] ?? 'este ponto').toLocaleLowerCase('pt-BR')
  return `O briefing diz mais de uma coisa sobre ${label}: ${options.join(' ou ')}. Qual delas vale?`
}

/** The same subject is asked to be kept and to be avoided. */
export function keepAndAvoidQuestion(subject: string): string {
  return `O briefing pede para manter e também para evitar “${subject}”. Qual dos dois vale?`
}

/** The briefing asks for something that is not in what the Apollo knows how to do at all. */
export function outsideVocabularySummary(kind: string): string {
  const known = DIRECTIVE_KIND_LABELS[kind]
  return known
    ? `O briefing pede algo sobre “${known.toLocaleLowerCase('pt-BR')}” que o Apollo não sabe fazer.`
    : 'O briefing pede algo que o Apollo não sabe fazer.'
}

/** The briefing asks for something the Apollo understands and does not execute yet. */
export function notExecutableSummary(kind: string, value: string, param?: string | number | null): string {
  return describeDirectiveLine(kind, value, param)
}
