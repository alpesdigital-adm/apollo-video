# ADR-155 — Um único plano renderizável, e materialização só por corte

- **Estado:** aceito
- **Data:** 2026-09-06
- **Contexto:** F4.015 e F4.016, Wave 20
- **Relacionado:** [ADR-122](ADR-122-manual-edit-and-proxy-first-render.md), [ADR-150](ADR-150-multi-range-editorial-synthesis.md), [ADR-152](ADR-152-react-playback-map-aggregate.md), `docs/specs/05-multicam-sync.md` §32.3

## Contexto

Dois derivados da Wave 20 produzem cortes que nada conseguia renderizar: o mapa
de playback do react (F4.015) e a síntese multi-range (F4.016). `DirectedEditPlan`
é o único plano que o caminho de render aceita, e `validateDirectedEditPlan`
(`director-run.ts:349`) é a única coisa que declara um plano renderizável.

Sem uma decisão, cada derivação teria criado o seu próprio tipo de plano: duas
formas, dois validadores, e um renderer que precisa descobrir qual dos dois
recebeu.

Há um segundo problema, de material e não de tipos. Um react tem trechos em que
a referência está **parada**. Materializar isso "corretamente" exigiria congelar
um quadro (taxa zero) ou compor duas imagens ao mesmo tempo. O caminho editorial
não tem nenhum dos dois: `assertClipRate` recusa taxa ≤ 0 e limita a faixa
suportada, e não existe composição de dois vídeos simultâneos no caminho
editorial.

## Decisão

**Uma única fábrica, `assembleDirectedEditPlan`
(`src/v2/application/renderable-edit-plan.ts`), monta o `DirectedEditPlan` das
duas derivações**, e deriva dos clipes tudo o que o validador confere: a duração
a partir do último clipe, o hash da linha de áudio a partir dos próprios clipes,
uma transição `straight-cut` por emenda. Um chamador não consegue declarar uma
duração que os seus clipes não somam.

`RENDERABLE_PLAN_ORIGINS` é fechado em `react-playback` e
`multi-range-synthesis`, e a versão do compilador é declarada
(`renderable-edit-plan/2026-09-05-v1`).

**A parte incômoda fica dita, não escondida.** O validador exige `storyPlanId`,
`treatmentPlanId` e `directorRunId`, e nenhum desses cortes veio de um
DirectorRun. Os três carregam `<origin>:<id>` — a derivação que os produziu — e
**nunca** um id com forma de director run, porque um id assim faria todo leitor
posterior, o repositório de proxy render incluído, acreditar que um crítico
aprovou o corte. `director.decisions` fica vazio pelo mesmo motivo, e as
`assumptions` do plano dizem isso em palavras.

**A materialização é só corte, e o plano declara isso.** Um trecho pausado
mostra o reactor, não um quadro congelado da referência. Um trecho de replay é o
mesmo material da referência cortado de novo. Nada é congelado, nada é
sobreposto, nada é retimeado.

**A linha do tempo de um react é a da reação**, peça por peça, e o compilador
afirma isso em vez de deixar implícito: o número de quadros do plano é comparado
com o da reação e diverge no máximo um quadro. Um compilador que lesse a duração
da referência produziria um plano que renderiza e está errado — e o erro só
apareceria quando alguém abrisse o arquivo.

## Consequências

**O que melhora.** O renderer continua conhecendo uma forma de plano só. Um
react de sessenta minutos sobre uma referência de trinta minutos roda sessenta
minutos, e isso é uma asserção do compilador, não uma expectativa. Medido nesta
máquina: `test:e2e:playback-map` compilou um mapa de 8 peças em um plano de 1200
quadros e 9 clipes, com uma linha de snapshot.

**O que piora.** Um react materializado por este caminho não mostra a referência
congelada durante a pausa, que é o que um editor humano faria. É uma limitação
de produto, não um detalhe de implementação, e está nas `assumptions` do plano
para que quem abrir o resultado saiba antes de estranhar.

**O que fica em aberto.** Freeze e picture-in-picture continuam fora do caminho
editorial. Enquanto continuarem, `retainedSourceRanges` lista o que sobrevive da
referência em segundos dela, e a reação não aparece ali — ela não é um intervalo
de origem retido, é a linha do tempo. A mesma ausência aparece fora do react: a
direção multicâmera entrega professor e tela em corte, um ângulo de cada vez, e
nunca compostos (spec 05 §29.5).
