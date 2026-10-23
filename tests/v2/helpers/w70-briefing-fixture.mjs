// The briefing of the W70 owner journey, and what the briefing interpreter answered for it. This is the content of a TEST CASE (ADR-160: a test may
// name a real video; the product may not): the Apollo's own code never carries any word of it.
//
// Two model answers are kept, because they prove two different things:
//
//  - W70_RUN1_MODEL_ANSWER is what the real model (Codex CLI, gpt-6-astra) said under prompt `brief-interpreter/v1`, on 22/10/2026. The raw text of that
//    reply was not kept (only its hash, 8d58ad14042d97898f8592863f6d1df0681ec8ad647cd58bef35eec7d6d0f5bb), so the answer below is RECONSTRUCTED from the
//    interpretation the Apollo recorded for it (the directives, the unsupported items and the question with their quotes, and the counts the audit kept:
//    0 moved to unsupported, 2 withdrawn as ambiguous). It is the "before": one executable directive, everything else unsupported or a question.
//
//  - W70_COVERAGE_MODEL_ANSWER is what a model that follows prompt `brief-interpreter/v2` must answer: AUTHORED by hand for this test, not produced by any
//    model. It is the "after" the vocabulary makes possible, and the standard the live opt-in test (tests/v2/brief-interpreter.live.mjs) holds a real
//    model to on the droplet.

export const W70_BRIEFING = 'Vídeo de boas-vindas da imersão Destravar ao Impactar, reaproveitado para quem acabou de garantir a vaga. O sorteio da sessão individual já terminou: tire todo o trecho que fala do sorteio e do formulário de inscrição. Quero duas versões: uma vertical para Reels e uma horizontal para YouTube. Na vertical, preencha a tela mantendo o rosto do Guilherme centralizado; na horizontal, mantenha o enquadramento original. A chamada para ação é travar a agenda para o encontro: mostre o texto "Trave sua agenda" na tela no momento em que ele fala para travar a agenda. Legendas curtas, que nunca cubram o rosto. Pode dar um leve zoom no começo para dar energia. Tom direto, sem música.'

export const W70_RUN1_MODEL_ANSWER = Object.freeze({
  directives: [
    { kind: 'cta', value: 'overlay-at-spoken-cta', param: null, quote: 'mostre o texto "Trave sua agenda" na tela no momento em que ele fala para travar a agenda' },
    { kind: 'avoid', value: 'subject', param: 'sorteio e do formulário de inscrição', quote: 'tire todo o trecho que fala do sorteio e do formulário de inscrição' },
    { kind: 'avoid', value: 'subject', param: 'música', quote: 'sem música' },
    { kind: 'layout', value: 'fill-crop', param: null, quote: 'Na vertical, preencha a tela' },
    { kind: 'layout', value: 'source-native', param: null, quote: 'na horizontal, mantenha o enquadramento original' },
  ],
  unsupported: [
    { summary: 'Duas versões: vertical para Reels e horizontal para YouTube.', quote: 'Quero duas versões: uma vertical para Reels e uma horizontal para YouTube.' },
    { summary: 'Manter o rosto do Guilherme centralizado na versão vertical.', quote: 'Na vertical, preencha a tela mantendo o rosto do Guilherme centralizado' },
    { summary: 'Usar o texto indicado na chamada para ação.', quote: 'mostre o texto "Trave sua agenda"' },
    { summary: 'Legendas curtas que nunca cubram o rosto.', quote: 'Legendas curtas, que nunca cubram o rosto.' },
  ],
  questions: [{ question: 'O leve zoom no começo deve aproximar ou afastar a imagem?', quote: 'Pode dar um leve zoom no começo para dar energia.' }],
  coverage: [
    { topic: 'audience', quote: 'quem acabou de garantir a vaga' },
    { topic: 'tone', quote: 'Tom direto' },
  ],
})

export const W70_COVERAGE_MODEL_ANSWER = Object.freeze({
  directives: [
    { kind: 'remove-speech', value: 'about', param: 'sorteio', quote: 'tire todo o trecho que fala do sorteio e do formulário de inscrição' },
    { kind: 'remove-speech', value: 'about', param: 'formulário de inscrição', quote: 'tire todo o trecho que fala do sorteio e do formulário de inscrição' },
    { kind: 'output', value: 'vertical', param: null, quote: 'uma vertical para Reels' },
    { kind: 'output', value: 'horizontal', param: null, quote: 'uma horizontal para YouTube' },
    { kind: 'output-layout', value: 'fill-following-face', param: 'vertical', quote: 'Na vertical, preencha a tela mantendo o rosto do Guilherme centralizado' },
    { kind: 'output-layout', value: 'source-native', param: 'horizontal', quote: 'na horizontal, mantenha o enquadramento original' },
    { kind: 'cta', value: 'overlay-at-spoken-cta', param: null, quote: 'no momento em que ele fala para travar a agenda' },
    { kind: 'cta-text', value: 'set', param: 'Trave sua agenda', quote: 'mostre o texto "Trave sua agenda" na tela' },
    { kind: 'invariant', value: 'captions-clear-of-face', param: null, quote: 'que nunca cubram o rosto' },
    { kind: 'movement', value: 'zoom', param: null, quote: 'Pode dar um leve zoom no começo' },
    { kind: 'absent', value: 'music', param: null, quote: 'sem música' },
  ],
  unsupported: [{ summary: 'Legendas mais curtas.', quote: 'Legendas curtas' }],
  questions: [],
  coverage: [
    { topic: 'audience', quote: 'quem acabou de garantir a vaga' },
    { topic: 'tone', quote: 'Tom direto' },
    { topic: 'context', quote: 'O sorteio da sessão individual já terminou' },
  ],
})

/** The parts of the briefing that are separate asks (a sentence, or the halves of one around a semicolon): each has to end in an item of the reading. */
export const W70_CLAUSES = Object.freeze([
  'Vídeo de boas-vindas da imersão Destravar ao Impactar, reaproveitado para quem acabou de garantir a vaga.',
  'O sorteio da sessão individual já terminou: tire todo o trecho que fala do sorteio e do formulário de inscrição.',
  'Quero duas versões: uma vertical para Reels e uma horizontal para YouTube.',
  'Na vertical, preencha a tela mantendo o rosto do Guilherme centralizado;',
  'na horizontal, mantenha o enquadramento original.',
  'A chamada para ação é travar a agenda para o encontro: mostre o texto "Trave sua agenda" na tela no momento em que ele fala para travar a agenda.',
  'Legendas curtas, que nunca cubram o rosto.',
  'Pode dar um leve zoom no começo para dar energia.',
  'Tom direto, sem música.',
])

// A transcript of the speech of that video as far as the test needs it: words with their times, grouped in segments, with the subject spoken twice.
export function w70Transcript() {
  const sentences = [
    { start: 0, text: 'Olá pessoal, bem-vindos ao encontro de hoje.' },
    { start: 10, text: 'Hoje eu vou mostrar como o método funciona na prática.' },
    { start: 40, text: 'Então já trava a sua agenda para o próximo encontro.' },
    { start: 58, text: 'Quem quiser participar do sorteio da sessão individual preenche o formulário de inscrição.' },
    { start: 66, text: 'O resultado do sorteio sai na sexta.' },
    { start: 74, text: 'Depois do sorteio, entra na área de membros e no grupo.' },
    { start: 90, text: 'Vamos ao conteúdo de verdade.' },
  ]
  const words = []
  const segments = []
  sentences.forEach((sentence, index) => {
    const tokens = sentence.text.split(' ')
    const begin = sentence.start
    tokens.forEach((word, wordIndex) => words.push({ word, start: begin + wordIndex * 0.5, end: begin + wordIndex * 0.5 + 0.45 }))
    segments.push({ id: index, start: begin, end: begin + tokens.length * 0.5, text: sentence.text })
  })
  return Object.freeze({ words: Object.freeze(words), segments: Object.freeze(segments) })
}
