# ADR-135 — React playback map and multicamera gate

React synchronization maps reference time to session time through piecewise play, pause, rewind and seek intervals. Recording duration never implies reference duration. Audio fingerprints, visible player events and visual matches contribute evidence; hidden players require manual anchors.

The F4 gate requires successful unequal-duration podcast and teacher+screen alignment, an explicit insufficient-evidence case, piecewise react editing, active-speaker/demonstration direction and a contextual 120-second multi-range synthesis. Every condition is independently visible before the phase is approved.

## Estado em 2026-09-06 — o que ficou demonstrado, e o que não

Implementado localmente nas Waves 18 a 20. **Integração final, deploy e aceite
do proprietário não aconteceram.**

### O mapa de react

O agregado existe como `react-playback-map/v1`
(`src/v2/domain/playback-map.ts`), e a razão de ele não ser um
`PiecewiseClockMap` está em [ADR-152](ADR-152-react-playback-map-aggregate.md).

Uma correção a este ADR: o vocabulário implementado tem **seis** modos
(`playing`, `paused`, `rewind`, `replay`, `seek`, `commentary-only`), não os
quatro que a prosa acima nomeia. `replay` e `commentary-only` são exatamente os
dois casos sobre os quais um vocabulário de quatro valores teria de mentir — um
replay não é um rewind, e um trecho em que o reactor fala por cima de nada não é
uma pausa. Os seis são a lista da spec 05 §16, e vivem em
`src/v2/domain/playback-mode.ts` justamente para que a página do editor de
âncoras ofereça a mesma lista que o schema da requisição publica.

"A duração da gravação nunca implica a duração da referência" foi transformada
em asserção do compilador, e não em expectativa: o plano compilado é comparado
com a duração da reação e diverge no máximo um quadro.

### O gate

O gate foi implementado como **dez** critérios, não seis: às seis condições
acima somaram-se match de cor antes da LUT criativa (FR-183), veredito fechado
do crítico de cor (FR-184), MP4 final inspecionável com codec, dimensões, taxa e
duração **medidos**, e ausência de dependência de runtime legado. Cada critério
é composto de checagens nomeadas, 38 no total, e cada uma é visível sozinha.
A forma da derivação está em
[ADR-156](ADR-156-phase-gate-derived-from-persisted-evidence.md).

### Demonstrado por execução

Medido em 2026-09-06 contra um cluster PostgreSQL 16 descartável levantado
localmente, com todas as migrações aplicadas do zero:

- `npm run test:e2e:multicam-longform-gate` (3 testes, 3 passes): o leitor real
  aprova um mundo completo 10/10; um projeto vazio satisfaz 1/10; **nove
  exclusões de uma linha cada derrubaram exatamente o seu próprio critério**,
  que é a prova de que "cada condição é independentemente visível" não é uma
  frase.
- `npm run test:e2e:phase-gate-journey` (1 teste, 1 passe): 13 avaliações pelas
  rotas `/v1` publicadas, aprovação 10/10, replay byte-a-byte idêntico, e quatro
  condições quebradas uma de cada vez derrubando cada uma a sua checagem —
  podcast dessincronizado, cobertura de uma faixa só, LUT criativa antes do
  match, e reação do mesmo tamanho da referência.

### Não demonstrado neste passe

As seis jornadas de produto que estão por trás das condições — podcast,
professor+tela, react, evidência insuficiente, direção e síntese multi-range —
existem como suítes registradas em passos nomeados do CI
(`test:e2e:podcast-multicam-journey`, `test:e2e:teacher-screen-journey`,
`test:e2e:react-playback-journey`, `test:e2e:insufficient-evidence-journey`,
`test:e2e:multicam-direction`, `test:e2e:longform-synthesis`) e **não** foram
executadas nesta máquina neste passe. O que foi executado aqui, do lado da
mídia, foi a renderização: um master de dez minutos virou um corte de 120,000 s
com 3600 quadros e 6 clipes tirados dos minutos 0, 1, 3, 5, 6 e 8
(`test:integration:synthesis-render`), e uma direção de duas câmeras virou 2
clipes cuja troca de ângulo foi confirmada por inspeção de pixel
(`test:integration:multicam-direction-render`).

Um gate aprovado em PostgreSQL não é implantação nem aceite. Nenhuma caixa de
F4.012 a F4.016 no `TODO.md` está marcada.
