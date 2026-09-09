# ADR-154 — `apollo-match` v2: white balance por ganho de canal, versionado

- **Estado:** aceito
- **Data:** 2026-09-06
- **Contexto:** F4.013 (FR-183), Wave 20
- **Relacionado:** [ADR-127](ADR-127-color-and-export-matrix.md), `docs/specs/05-multicam-sync.md` §30

## Contexto

FR-183 pede igualar exposição, **white balance**, contraste, saturação e pele
antes da LUT. O provedor `apollo-match` que existia aceitava um único filtro
`eq` com `brightness`, `contrast` e `saturation`
(`ffmpeg-color-pipeline-processor.ts:107-110`). `eq` não tem ganho por canal:
não há como corrigir uma câmera que puxa azul sem mexer nas três ao mesmo tempo.

Duas saídas ruins estavam disponíveis. A primeira: estender o filtro em silêncio
e continuar chamando o provedor de `apollo-match`, sem versão nova — o que faria
uma compilação antiga e uma nova, com os mesmos parâmetros nominais, produzirem
pixels diferentes sob o mesmo `parametersHash`. A segunda: declarar que white
balance fica fora do escopo e reportar FR-183 como parcialmente entregue sem
dizer o que isso custa a quem grava com duas câmeras de marcas diferentes.

## Decisão

**O provedor ganha uma segunda versão declarada, `MATCH_PROVIDER_VERSIONS.v2`,
e a versão faz parte de `implementation.version`.**

- **v1** — `eq`, parâmetros `mode`, `brightness`, `contrast`, `saturation`. É o
  que o processador aceita hoje, e permanece intacto.
- **v2** — `colorchannelmixer=rr=<red-gain>:gg=<green-gain>:bb=<blue-gain>`
  antes do mesmo `eq`; parâmetros adicionais `red-gain`, `green-gain`,
  `blue-gain`.

Uma transformação v2 tem hash diferente de uma v1, e por isso as compilações
existentes não são tocadas.

**Os nomes dos parâmetros são minúsculos com hífen, e não camelCase**, porque
`createColorPlan` valida toda chave de `implementation.parameters` contra a
gramática TOKEN de `color-and-export.ts`, que não aceita maiúsculas. Uma chave
`redGain` torna a camada `cameras` inteira inaceitável pela autoridade. A forma
do parâmetro é ditada por ela, não pelo gosto deste módulo — e essa é a razão de
`MATCH_WHITE_BALANCE_PARAMETERS` existir como tabela em vez de string literal
espalhada.

**Os ganhos são limitados**: `MATCH_PARAMETER_BOUNDS.gain` é `[0,5; 2]`, e um
ganho de canal fora disso não é balanço, é grade. Acima de
`DEFAULT_MULTICAM_MATCH_POLICY.maxWhiteBalanceGain = 1,25` a correção é grampeada
no limite e o plano sai com `humanReviewRequired` — nunca aplicada em força
total, nunca descartada em silêncio.

**Abaixo de `whiteBalanceGainTolerance = 0,02` a v2 não é usada**: se os ganhos
já estão dentro de 1 ± 0,02, o estágio de white balance não acrescenta nada e o
plano fica em v1. Uma versão nova que aparecesse mesmo quando não faz diferença
tornaria impossível ler, de um plano, se o white balance foi corrigido.

## Consequências

**O que melhora.** Duas câmeras de temperaturas diferentes convergem sem que
alguém precise graduar à mão. Medido sobre pixels reais
(`tests/v2/color-visual-evaluations.integration.mjs`, executado em 2026-09-06):
a razão azul/verde da câmera B passou de 0,916081 para 1,046333 contra uma
referência de 1,047486 — de 12,54 % de erro para 0,11 % — com ganho aplicado de
1,143444. Com três câmeras, o erro de vermelho caiu de 17,03 % para 1,05 %.

**O que piora.** A whitelist do processador FFmpeg foi estendida nesta wave, e
os números do parágrafo acima só existem por causa disso.
`ffmpeg-color-pipeline-processor.ts:137-188` lê `implementation.version`, confere
cada chave de `parameters` contra `MATCH_PROVIDER_VERSIONS[version].parameters`,
valida `red-gain`/`green-gain`/`blue-gain` contra `MATCH_PARAMETER_BOUNDS.gain` e
devolve `colorchannelmixer=rr=…:gg=…:bb=…,eq=…` (linha 187). O ganho aplicado de
1,143444 está muito fora de `whiteBalanceGainTolerance = 0,02`, de modo que o
plano que a avaliação visual renderizou era v2, não v1.
`tests/v2/color-match-service.test.mjs:897` (`T-F4.013 apollo-match v2 renders a
colorchannelmixer before the eq`) afirma a cadeia exata.

O custo que sobra é o de duas versões vivas no mesmo provedor. `parametersHash` e
`pipelineHash` são calculados sobre todo o objeto de parâmetros, então uma
compilação que hasheou como v1 tem de continuar renderizando exatamente o que a
v1 renderizava — são dois caminhos de render para manter em sincronia, não um. E
a versão é um contrato entre plano e processador: um plano v2 que chegue a um
build anterior a esta wave é recusado com `INVALID_RENDER_INPUT` (linha 143), não
renderizado por aproximação.

**O que fica em aberto.** A dimensão `skin` que FR-183 nomeia é **medida**
(matiz do croma médio da banda de pele) mas não entra em nenhuma transformação:
`COLOR_MEASUREMENT_COMPARABILITY_DIMENSIONS` são white balance, exposição,
contraste e saturação. Pele informa o crítico (§31); não move o match.
