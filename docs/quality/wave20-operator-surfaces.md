# Wave 20 — as quatro telas de operador, e a que não foi entregue

O briefing da Wave 20 nomeia quatro superfícies de operador sobre as capabilities
já publicadas: direção (F4.012), cor (F4.013/F4.014), playback (F4.015) e **gate
de fase (F4.016) — critérios um a um, o que falta, links para os artifacts**.

Três foram entregues. A quarta **não foi**, e o registro disto é o objetivo deste
arquivo: uma superfície ausente sem decisão escrita é indistinguível de um
esquecimento, e o relatório de paridade não a mostra porque ele só compara o que
a UI chama com o que a API publica — uma tela que não existe não aparece em
nenhum dos dois lados.

## Por que a tela do gate não pode existir hoje

O domínio e a aplicação do gate multicâmera/long-form existem no repositório
(`src/v2/domain/multicam-longform-gate.ts`,
`src/v2/application/multicam-longform-gate.ts`,
`src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts`,
`src/v2/infrastructure/audit/module-graph-legacy-runtime-audit.ts`).

A superfície `/v1` **não** existe:

- `capability-registry.ts` não publica nenhuma capability de gate multicâmera. As
  únicas capabilities com "gate" no nome são `apollo.projects.mvp-core-gates.run`
  e `apollo.projects.mvp-core-gates.list`, que são o gate do MVP Core e não este.
- `src/app/v1` tem uma única rota com "gate" no caminho:
  `src/app/v1/projects/[projectId]/mvp-core-gates/route.ts`.

Uma tela de operador que lesse o gate por qualquer outro caminho — um serviço
importado direto, uma rota interna, um `/api/` novo — quebraria a regra que
governa esta wave inteira: **a UI usa a mesma capability pública, e nada além
dela**. Entregar a tela sem a API seria entregar uma tela que mente sobre de onde
veio o número.

## O que falta, e em que ordem

1. Publicar as capabilities do gate F4.016 (executar; ler o último; listar o
   histórico; critérios com o que falta; abrir artifacts), pela receita de 13
   passos do `MAP.md` §6 — registry, schemas por spread das constantes de
   domínio, exemplos construídos por factory e presenter reais, cobertura de
   concorrência e de pré-condição, baseline e relatório de paridade.
2. Só então a tela: critérios um a um, o que cada um mediu, o que falta para
   passar, e os artifacts alcançáveis a partir do veredito.

## Como este arquivo se invalida sozinho

`tests/v2/wave20-operator-ui.test.mjs` falha no momento em que uma capability de
gate multicâmera aparecer no registry sem que esta nota seja revista. Uma decisão
de descope que sobrevive à razão que a justificou vira desculpa, e um documento
que ninguém é obrigado a reler não é registro nenhum.
