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
  'cta-text': 'Texto da chamada escrita',
  output: 'Versões do vídeo',
  'output-layout': 'Enquadramento de uma versão',
  'remove-speech': 'Tirar trecho da fala',
  invariant: 'Garantia do Apollo',
  absent: 'O que o Apollo não acrescenta',
})

export const CAPTION_STYLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  kinetic: 'Cinético', 'karaoke-box': 'Karaokê com caixa', 'karaoke-pill': 'Karaokê em pílula', 'caps-stroke': 'Maiúsculas com contorno', 'clean-color': 'Limpo com cor',
})

export const DIRECTIVE_VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  movement: Object.freeze({
    none: 'Sem movimento de câmera',
    'punch-in': 'Aproximação brusca (o Apollo ainda não aplica esse movimento)',
    zoom: 'Zoom (o Apollo ainda não aplica zoom)',
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
    'fill-crop': 'Preencher a tela acompanhando o rosto',
  }),
  'caption-language': Object.freeze({ set: 'Idioma das legendas' }),
  output: Object.freeze({
    vertical: 'Uma versão vertical',
    horizontal: 'Uma versão horizontal',
    square: 'Uma versão quadrada',
    aspect: 'Uma versão na proporção pedida',
    omit: 'Não produzir uma versão',
  }),
  'output-layout': Object.freeze({
    'fill-following-face': 'Preencher a tela acompanhando o rosto',
    'source-native': 'Manter o enquadramento da gravação',
    'fit-with-backdrop': 'Encaixar a imagem inteira com fundo',
  }),
  invariant: Object.freeze({ 'captions-clear-of-face': 'A legenda nunca cobre o rosto (regra do Apollo, vale em todo vídeo)' }),
  absent: Object.freeze({
    music: 'Sem música (o Apollo não acrescenta música)',
    effects: 'Sem efeitos (o Apollo não acrescenta efeitos)',
    transitions: 'Sem transições (o Apollo só faz cortes secos)',
  }),
})

/** How a request points at an output, in words: the shape of the frame, an aspect ratio, or every version. */
export function describeOutputReference(reference: string): string {
  if (reference === 'all') return 'todas as versões'
  if (reference === 'vertical') return 'a versão vertical'
  if (reference === 'horizontal') return 'a versão horizontal'
  if (reference === 'square') return 'a versão quadrada'
  return `a versão ${reference}`
}

/** "na versão vertical" / "em todas as versões". */
export function inOutputReference(reference: string): string {
  return reference === 'all' ? 'em todas as versões' : `n${describeOutputReference(reference)}`
}

/** "da versão vertical" / "de todas as versões". */
export function ofOutputReference(reference: string): string {
  return reference === 'all' ? 'de todas as versões' : `d${describeOutputReference(reference)}`
}

export interface DirectiveWords { label: string; text: string }

/** The words for one directive, with its parameter: `Abertura` / `Proteger os primeiros segundos (3 s)`. A code the catalog does not know is shown as it is. */
export function describeDirectiveWords(kind: string, value: string, param?: string | number | null): DirectiveWords {
  const label = DIRECTIVE_KIND_LABELS[kind] ?? kind
  if (kind === 'caption-language') return { label, text: String(param ?? '') }
  if (kind === 'caption-style') return { label, text: CAPTION_STYLE_LABELS[value] ?? value }
  if (kind === 'keep' || kind === 'avoid') return { label, text: String(param ?? '') }
  if (kind === 'cta-text') return { label, text: `“${String(param ?? '')}”` }
  if (kind === 'remove-speech') return { label, text: `tirar da fala o que fala de “${String(param ?? '')}”` }
  if (kind === 'output' && value === 'omit') return { label, text: `Não produzir ${describeOutputReference(String(param ?? ''))}` }
  if (kind === 'output' && value === 'aspect') return { label, text: `Uma versão na proporção ${String(param ?? '')}` }
  if (kind === 'output-layout') return { label, text: `${DIRECTIVE_VALUE_LABELS['output-layout']?.[value] ?? value}, ${inOutputReference(String(param ?? ''))}` }
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

/** The asks of one kind that the Apollo cannot execute, together: they are one unsupported item, not a question about details of something it will not do. */
export function notExecutableTogetherSummary(kind: string, options: readonly string[]): string {
  const label = DIRECTIVE_KIND_LABELS[kind] ?? 'Pedido'
  return `${label}: ${options.join(' ou ')}`
}

/** A sentence of the briefing that the reading could not place: the owner says what it is. */
export const UNPLACED_STATEMENT_LABEL = 'Isso não pede nada ao vídeo'
export const UNPLACED_REQUEST_LABEL = 'Isso pede algo que o Apollo não sabe fazer'
export function unplacedSentenceQuestion(sentence: string): string {
  const shown = sentence.length > 300 ? `${sentence.slice(0, 299)}…` : sentence
  return `O Apollo não entendeu o que esta frase do briefing pede ao vídeo: “${shown}”. O que ela é?`
}

// ---- The sentences the resolution writes when what the request asks for needs the owner (they reach the owner as the reasons the Director is blocked). ----

/** Seconds as a person reads them: `58,1 s`. */
export function secondsInWords(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
}

/** The request asks for a version of the video that the project has no output for. */
export function outputMissingQuestion(reference: string): string {
  return `O pedido quer ${describeOutputReference(reference)}, e este projeto não tem uma saída assim. Quer criar essa saída? Crie a saída e peça ao Diretor de novo; se não quiser, tire o pedido do briefing.`
}

/** A layout is asked for an output the project does not have. */
export function outputLayoutWithoutOutputQuestion(reference: string): string {
  return `O pedido fala do enquadramento ${ofOutputReference(reference)}, e este projeto não tem uma saída assim. Crie a saída ou tire o pedido do briefing.`
}

/** The source frame is asked to be kept on an output whose frame is another shape. */
export function outputLayoutNativeMismatchQuestion(reference: string, sourceShape: string, outputShape: string): string {
  return `O pedido manda manter o enquadramento da gravação ${inOutputReference(reference)}, mas a gravação (${sourceShape}) não tem o formato dessa saída (${outputShape}). Quer a imagem inteira com fundo, ou preencher a tela acompanhando o rosto?`
}

/** The text of the written call to action is given twice and differently. */
export function ctaTextConflictQuestion(inBriefing: string, inField: string): string {
  return `O briefing pede o texto “${inBriefing}” na chamada escrita, e o pedido já traz o texto “${inField}”. Qual dos dois vale?`
}

/** A request for ONE output of several, in a project whose plan is one timeline for all of them. */
export function variantOverrideAloneSummary(outputCount: number, line: string): string {
  return `O plano do vídeo é um só para as ${outputCount} saídas do projeto, então o pedido só para uma delas não pode ser feito (${line}).`
}

/** The words of a written call are given, and so is a request that no written call is drawn. */
export function ctaTextWithoutOverlayQuestion(text: string, placement: string): string {
  const no = placement === 'verbal-only' ? 'só falada, sem texto na tela' : 'sem chamada para ação'
  return `O pedido quer escrever “${text}” na tela e também pede a chamada ${no}. Qual dos dois vale?`
}

/** The project has an output the request, which names the versions it wants, does not name. */
export function outputNotAskedQuestion(aspectRatio: string): string {
  return `Este projeto tem uma saída ${aspectRatio} que o briefing não pede. Escolha: manter e produzir esta saída (diga no briefing que quer essa versão) ou não produzir esta saída nesta edição (diga no briefing que essa versão não deve ser feita: o Apollo a deixa de fora e recusa o render dela). O Apollo não escolhe por você, e ainda não tem como apagar uma saída do projeto.`
}

/** The request leaves out a version the project has not got. */
export function outputOmitWithoutOutputQuestion(reference: string): string {
  return `O pedido manda não produzir ${describeOutputReference(reference)}, e este projeto não tem uma saída assim. Tire o pedido do briefing ou confira a versão.`
}

/** A request for an output the project does not have, in a field that names the output. */
export function variantOverrideWithoutOutputSummary(line: string): string {
  return `O pedido é para uma saída que este projeto não tem, então não pode ser feito (${line}).`
}

/** The video already has music and the request asks for none: the Apollo has no way to take music out. */
export function musicAlreadyInVideoSummary(): string {
  return 'O vídeo já tem música e o Apollo ainda não tira música de um vídeo.'
}

/** One line of what a spoken subject was found in: where it is and what is said there. */
export function speechCandidateLine(startSeconds: number, endSeconds: number, text: string): string {
  return `${secondsInWords(startSeconds)} a ${secondsInWords(endSeconds)}: “${text}”`
}

/** The Apollo found the subject to take out of the speech and asks the owner to confirm exactly what would go. */
export function speechRemovalConfirmQuestion(subject: string, lines: readonly string[], more: number, basis: 'phrase' | 'words'): string {
  const found = basis === 'phrase'
    ? `Achei trechos sobre “${subject}” na fala`
    : `Não achei a frase “${subject}” inteira; achei trechos com as palavras dela`
  return `${found}. Estes trechos sairiam do vídeo: ${lines.join(' | ')}${more > 0 ? ` | e mais ${more}` : ''}. Confirme para o Apollo cortar; nada é cortado sem a sua confirmação.`
}

/** The subject to take out of the speech is not in the transcript. */
export function speechRemovalNotFoundQuestion(subject: string): string {
  return `Não achei na fala nada sobre “${subject}”. Diga a frase como ela aparece na fala e peça o corte dela, ou tire o pedido do briefing.`
}

/** The subject to take out of the speech cannot be searched yet: the video has no transcript. */
export function speechRemovalNeedsTranscriptQuestion(subject: string): string {
  return `O pedido manda tirar da fala o que fala de “${subject}”, e o vídeo ainda não tem transcrição para achar o trecho. Transcreva o vídeo e peça ao Diretor de novo.`
}

/** A subject too long to be searched as a phrase. */
export function speechRemovalTooLongQuestion(subject: string): string {
  return `O assunto “${subject}” é longo demais para ser buscado na fala. Escreva só o nome do assunto no briefing.`
}

// ---- The questions of the resolution about the call to action, the opening and the language. ----

export const DESIRED_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'continue-viewing': 'continuar assistindo', 'submit-lead': 'deixar os dados', buy: 'comprar', 'message-whatsapp': 'chamar no WhatsApp', book: 'agendar', download: 'baixar',
})

/** A language tag as a person reads it: `pt-BR` is "português (Brasil)". A tag the runtime cannot name is shown as it is. */
export function languageInWords(tag: string): string {
  try {
    return new Intl.DisplayNames(['pt-BR'], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

export const RESOLUTION_QUESTION_TEXTS = Object.freeze({
  openingFirstSentenceUnknown: (): string =>
    'O pedido protege a primeira frase da fala, e a fala não mostra onde a primeira frase termina. Até que segundo a abertura deve ser protegida?',
  ctaNotEvaluable: (actionKind: string, language: string): string =>
    `O objetivo pede a ação “${DESIRED_ACTION_LABELS[actionKind] ?? actionKind}”, e o Apollo não tem a lista das palavras que a pedem em ${languageInWords(language)}. Qual é a chamada falada exata, para que ela possa ser conferida?`,
  ctaConflictsWithAction: (actionKind: string): string =>
    `O objetivo pede a ação “${DESIRED_ACTION_LABELS[actionKind] ?? actionKind}”, e o pedido diz que não haverá chamada para ação. Qual dos dois vale?`,
  ctaOverlayTextMissing: (): string => 'O pedido quer uma chamada escrita na tela, e a ação desejada não traz o texto dela. O que ela deve dizer?',
  ctaOverlayTimelineUnknown: (): string =>
    'O pedido põe a chamada escrita no vídeo, e a duração do vídeo montado ainda não é conhecida. Peça ao Diretor de novo quando a linha do tempo existir.',
  ctaOverlayAfterEnd: (startSeconds: number, durationSeconds: number): string =>
    `O pedido desenha a chamada escrita a partir de ${secondsInWords(startSeconds)}, e o vídeo dura ${secondsInWords(durationSeconds)}. A partir de que segundo ela deve aparecer?`,
  ctaOverlayPlacementUnknown: (): string =>
    'A chamada escrita aparece onde a fala diz a chamada, e a fala não mostra nenhuma que o Apollo reconheça. Onde ela deve aparecer?',
  layoutSourceNativeMismatch: (sourceShape: string, outputShapes: string): string =>
    `O pedido manda manter o enquadramento da gravação (${sourceShape}), e ele não tem o formato da saída (${outputShapes}). Quer a imagem inteira com fundo?`,
  captionLanguageTranslation: (requested: string, spoken: string, detected: boolean): string =>
    `As legendas foram pedidas em ${languageInWords(requested)}, mas a fala está em ${languageInWords(spoken)} (${detected ? 'detectado na mídia' : 'idioma declarado para o projeto, não conferido com a fala'}) e o Apollo não traduz aqui. As legendas devem ficar em ${languageInWords(spoken)}?`,
  declaredLanguageDiffers: (declared: string, detected: string): string =>
    `O projeto declara ${languageInWords(declared)}, e o reconhecimento de fala detectou ${languageInWords(detected)} na mídia. Em que idioma ficam as legendas?`,
  captionLanguageUnknown: (): string => 'Em que idioma as legendas devem ser escritas? O pedido não diz e a transcrição não informa.',
})
