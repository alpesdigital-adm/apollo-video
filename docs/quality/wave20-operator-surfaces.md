# Wave 20 — as quatro telas de operador

O briefing da Wave 20 nomeia quatro superfícies de operador sobre as capabilities
publicadas: direção (F4.012), cor (F4.013/F4.014), playback (F4.015) e **gate de
fase (F4.016) — critérios um a um, o que falta, links para os artifacts**.

**As quatro existem.** Este arquivo continua sendo o registro de por que a quarta
chegou depois das outras três, porque uma superfície que aparece fora de ordem
sem explicação é indistinguível de um acidente.

## Por que a tela do gate veio na fase seguinte

As três primeiras telas foram construídas quando a superfície `/v1` de direção,
cor e playback já existia. A do gate não podia ser construída no mesmo momento:
o domínio, a aplicação e a persistência do gate multicâmera/long-form existiam
(`src/v2/domain/multicam-longform-gate.ts`,
`src/v2/application/multicam-longform-gate.ts`,
`src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts`), mas
nenhuma capability publicava o gate, e portanto não havia caminho `/v1` para uma
tela ler.

Uma tela de operador que lesse o gate por qualquer outro caminho — um serviço
importado direto, uma rota interna, um `/api/` novo — quebraria a regra que
governa esta wave inteira: **a UI usa a mesma capability pública, e nada além
dela**. Entregar a tela sem a API seria entregar uma tela que mente sobre de onde
veio o número. Por isso a ordem foi: primeiro a API, depois a tela.

## O que existe hoje

Seis capabilities carregam o gate — executar, ler o último, ler um pelo id,
listar o histórico, ler o que falta, listar os artifacts — publicadas pela
receita de 13 passos do `MAP.md` §6: registry, schemas com enums por spread das
constantes de domínio, exemplos construídos por factory e presenter reais,
cobertura de concorrência e de pré-condição, baseline e relatório de paridade.

A tela está em `src/app/multicam-longform-gate/page.tsx`, alcançável a partir de
`/capture-sessions`, e mostra os dez critérios um a um, o que cada um leu, o que
falta para passar, e os artifacts alcançáveis a partir do veredito.

## Como este arquivo se mantém honesto

`tests/v2/wave20-operator-ui.test.mjs` lê esta nota e a página. A checagem que
existia enquanto a tela faltava era negativa e vencia sozinha: falhava no momento
em que uma capability de gate aparecesse no registry. Ela venceu, e foi
substituída pela checagem positiva que vale a partir de agora — cada caminho
`/v1` que a tela alcança tem de ser um caminho que uma capability de gate
declara, exatamente como as outras três telas são cobradas. Uma decisão de
descope que sobrevive à razão que a justificou vira desculpa; um documento que
ninguém é obrigado a reler não é registro nenhum.
