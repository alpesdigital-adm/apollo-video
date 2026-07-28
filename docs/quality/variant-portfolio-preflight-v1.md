# F2.012 — Preflight de portfólio de variantes v1

## 1. Resultado do slice

Este gate transforma o compatibility graph aceito em um portfólio limitado,
diverso e economicamente explícito antes que qualquer trabalho pago seja
criado. O Apollo V2 agora:

- calcula o espaço teórico com aritmética inteira sem construir o produto
  cartesiano;
- conta somente caminhos integralmente aceitos como candidatos elegíveis;
- aplica hard filters, score mínimo, deduplicação, limite semântico e top-N;
- procura cobrir hooks, corpos e CTAs distintos dentro do limite solicitado;
- respeita o orçamento restante e o limite máximo de saídas do workspace;
- reconhece recipes já compiladas e estima seu reaproveitamento sem cobrar nova
  produção;
- apresenta quantidade, custo, duração, armazenamento, cobertura e exclusões
  antes da produção;
- exige confirmação assinada quando a solicitação ultrapassa o padrão do
  workspace;
- persiste políticas e preflights imutáveis no PostgreSQL V2;
- expõe criação, leitura e listagem pela API pública `/v1`;
- exibe o funil `Possíveis → Elegíveis → Escolhidas → Saídas` em `/batches`.

Um preflight nunca cria jobs e nunca materializa a matriz de saídas. Essas duas
propriedades existem no domínio, no JSON persistido, em projeções relacionais e
em constraints do banco.

## 2. Contagem sem produto cartesiano

A versão `variant-portfolio-selection/v1` trabalha sobre os nodes e edges do
compatibility graph imutável.

Quando prova é obrigatória, a contagem teórica é:

`hooks × corpos × provas × CTAs`

Quando prova é opcional, a contagem é:

`hooks × corpos × (provas + caminho sem prova) × CTAs`

As contagens usam `BigInt` e são expostas como strings decimais. A contagem
elegível percorre apenas adjacências aceitas:

- `hook-body`;
- `body-proof` e `proof-cta`; ou
- `body-cta`, quando a política permite omitir prova.

O domínio não cria um array com todas as combinações. A inspeção de candidatos
é limitada por `maxCandidateScanCount`; o pool de ranking também é limitado. O
resultado registra:

- `theoreticalCandidateCount`;
- `eligibleCandidateCount`;
- `scannedCandidateCount`;
- `scanTruncated`;
- `productMaterialized=false`;
- `estimates.jobsCreated=0`.

O golden de regressão com seis hooks, três corpos e três CTAs comprova 54
possibilidades e 54 caminhos elegíveis sem materializar uma matriz cartesiana.

## 3. Filtros, qualidade e diversidade

O preflight reutiliza o mesmo score versionado do `VariantRecipe`. Antes do
top-N, cada candidato passa por:

1. edges aceitos e acima do score mínimo;
2. score mínimo da recipe;
3. deduplicação por hash canônico;
4. limite de candidatos inspecionados;
5. limite de recipes por cluster semântico;
6. capacidade máxima de saídas;
7. orçamento restante.

O ranking combina score total, elo mais fraco, ganho de cobertura, novidade de
nodes e penalidade por repetição semântica. Empates são resolvidos por hash
canônico, mantendo determinismo.

Recipes já existentes são identificadas pela ordem exata dos graph nodes. Elas
podem ser selecionadas mesmo quando não há orçamento para produção nova e
entram como reuso com custo, job e armazenamento incremental iguais a zero.

O resultado explica quantos candidatos foram removidos por hard filter,
qualidade, duplicidade, cluster semântico, orçamento e capacidade, além de
reason codes estáveis.

## 4. Cobertura e orçamento

A policy `variant-portfolio-policy/v1` possui revisão e hash imutáveis. O
default inicial define:

- 12 recipes sem confirmação adicional;
- máximo de 50 recipes e 250 saídas;
- score mínimo 70 para edges e recipes;
- cobertura desejada de dois hooks, dois corpos e dois CTAs;
- no máximo duas recipes por cluster semântico;
- inspeção de até 10.000 candidatos;
- estimativas unitárias de custo, duração e armazenamento;
- quatro jobs concorrentes;
- validade de 15 minutos para confirmação.

A cobertura efetiva é limitada pela disponibilidade real de nodes e pelo
tamanho máximo possível do portfólio. O resultado distingue cobertura exigida,
alcançada e indisponível no threshold de qualidade.

O orçamento vem do batch persistido:

`maxCostMinorUnits - reservedCostMinorUnits`

O caller não informa nem aumenta esse valor. Da mesma forma, quantidade de
formatos, objetivo, recipes reutilizáveis, graph e policy são derivados pelo
servidor.

## 5. Estimativas antes da produção

`variant-portfolio-estimate/v1` apresenta:

- quantidade de recipes selecionadas;
- quantidade de saídas;
- recipes e saídas reaproveitadas;
- jobs planejados;
- custo estimado em unidades monetárias menores;
- tempo estimado com concorrência limitada;
- armazenamento estimado;
- taxa esperada de reuso.

`plannedJobCount` é uma estimativa, não uma fila criada. Durante todo o
preflight:

- `jobsCreated=0`;
- `productMaterialized=false`.

A interface comunica explicitamente “Nenhum render começa aqui”, a quantidade
de caminhos inspecionados e a ausência de jobs criados.

## 6. Confirmação assinada

Solicitações acima de `defaultRecipeLimit` produzem primeiro um preflight com
status `confirmation-required` e limite efetivo igual ao default. A resposta
inclui um token HMAC temporário vinculado a:

- API client e workspace;
- fingerprint exato da solicitação;
- graph `runHash`;
- policy `policyHash`;
- quantidade solicitada;
- matriz de formatos do batch;
- orçamento restante;
- expiração.

O contrato não aceita `confirmed=true`, `confirmedExpansion` ou qualquer
booleano equivalente controlado pelo caller. Para confirmar, o cliente repete a
solicitação com nova `Idempotency-Key` e o token assinado. Alteração de graph,
policy, orçamento, matriz, ator ou payload invalida a confirmação.

## 7. Persistência PostgreSQL V2

A migration `20260728050000_variant_portfolio_preflights` cria:

- `variant_portfolio_policies`;
- `variant_portfolio_preflight_runs`.

As políticas são append-only por workspace e revisão. Cada preflight referencia
o workspace, project, batch, graph, take library, graph hash, policy hash e API
client exatos.

Constraints verificam versões, status, limites, contagens, hashes, JSON,
estimativas e confirmação. A constraint
`variant_portfolio_preflight_no_jobs_check` rejeita qualquer tentativa de
persistir `jobsCreated != 0` ou `productMaterialized=true`.

Depois deste gate, o schema V2 possui 79 tabelas, 390 índices e 282 foreign
keys. O E2E reconstruiu e usou um PostgreSQL isolado com pgvector e executou a
rota pública real contra o build de produção local.

## 8. API pública

As três capabilities estão em discovery, OpenAPI, schemas versionados,
exemplos, catálogo de tools, safety policy e contratos de concorrência:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.variant-portfolio-preflights.list` | `GET /v1/batches/{batchId}/variant-portfolio-preflights` | `projects:read` |
| `apollo.batches.variant-portfolio-preflights.create` | `POST /v1/batches/{batchId}/variant-portfolio-preflights` | `projects:write` |
| `apollo.batches.variant-portfolio-preflights.read` | `GET /v1/batches/{batchId}/variant-portfolio-preflights/{preflightId}` | `projects:read` |

Criação exige `Idempotency-Key`, graph ID, graph `runHash` e quantidade
solicitada. Replay retorna a execução original; reutilizar a chave com outro
payload ou enviar evidência stale falha explicitamente.

Depois deste gate, o contrato público possui 127 capabilities, 203 schemas, 235
exemplos e 103 paths, sem regressão do baseline anterior.

## 9. Interface `/batches`

O painel `Portfolio slate` apresenta:

- seletor de preflights imutáveis;
- quantidade de recipes desejadas;
- criação pelo mesmo endpoint público disponível a integrações externas;
- funil de possíveis, elegíveis, escolhidas e saídas;
- aviso explícito de produto cartesiano não materializado;
- confirmação de zero jobs criados;
- cobertura de hooks, corpos e CTAs;
- ranking, score, elo mais fraco, novidade e reuso;
- custo, tempo, armazenamento, taxa de reuso e jobs planejados;
- exclusões e alertas;
- fluxo de confirmação assinada acima do padrão do workspace.

A seleção é invalidada quando batch, alignment, take library ou compatibility
graph mudam. A interface não possui rota interna privilegiada nem cálculo
alternativo no cliente.

## 10. Regressões locais

O conjunto `T-FR-085` cobre:

- contagem teórica e elegível;
- hard filters e threshold;
- deduplicação e top-N limitado;
- diversidade e cobertura mínima;
- orçamento e capacidade;
- reuso sem custo de regeneração;
- estimativas de custo, duração e armazenamento;
- ausência de materialização e criação de jobs;
- confirmação assinada vinculada ao estado;
- rejeição de confirmação controlada pelo caller;
- idempotência, payload conflitante e graph stale;
- leitura, listagem e descoberta das capabilities;
- projections, foreign keys e constraints PostgreSQL.

Resultados locais antes do deploy:

- regressão integral: 543/543;
- build Next.js de produção: aprovado;
- integração PostgreSQL/API real: 1/1;
- interface desktop 1440 × 1000: sem overflow ou erro de console;
- interface mobile 390 × 844: sem overflow ou erro de console;
- zero caracteres Unicode de substituição ou mensagens corrompidas;
- typecheck: aprovado;
- lint arquitetural V2-only/PostgreSQL/API-first: aprovado;
- schema/migrations: 79 tabelas, 390 índices e 282 foreign keys;
- contratos públicos: 127 capabilities, 203 schemas, 235 exemplos e 103 paths.

## 11. Evidência de produção

O gate permanece aberto no `TODO.md` até que a migration, API e interface deste
commit sejam implantadas e comprovadas no PostgreSQL de produção. Esta seção
será preenchida com commit, imagem, backup, smoke de API, invariantes do banco e
prova visual do artefato efetivamente implantado.

## 12. Limite honesto deste gate

F2.012 decide quantas recipes são seguras e valem o custo. Ele não cria os
batch items nem agenda sua produção. A edição em lote, retries independentes e
fila de execução pertencem ao F2.013.

Portanto, um preflight pronto não autoriza por si só materialização, cobrança ou
render. O próximo gate deve consumir somente um preflight confirmado e ainda
preservar os limites nele comprovados.
