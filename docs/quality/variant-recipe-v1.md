# F2.011 — VariantRecipe v1

## 1. Resultado do slice

Este gate transforma um caminho integralmente aceito pelo compatibility graph
em uma receita editorial imutável e rastreável. O Apollo V2 agora:

- seleciona hook, corpo, prova opcional e CTA em ordem canônica;
- exige que cada transição usada seja um edge aceito do mesmo graph;
- aplica a política de prova a partir do objetivo real do batch;
- permite um pedido `requireProof` apenas para tornar a política mais estrita;
- registra assumptions estruturadas e evidence refs;
- calcula scores de edge, weakest link, objetivo e total;
- compila `StoryPlan` e `EditPlan` por referência;
- preserva um único master reference por artifact e os hashes das fontes;
- registra lineage até graph node, take, `ScriptBlock`, source segment, artifact,
  range e hash;
- permite cold open curto, limitado ao source range e com retorno ao hook;
- expõe criação, leitura e listagem pela API pública `/v1`;
- exibe seleção, score, ordem, lineage e integridade do compiler em `/batches`.

Não há materialização de mídia, duplicação de masters, fallback em memória,
rota interna privilegiada ou dependência do pipeline legado.

## 2. Ordem e política de prova

A ordem canônica aceita é:

- `hook → body → proof → cta`; ou
- `hook → body → cta`, somente quando a política do objetivo permite omitir
  prova.

Cada node precisa pertencer ao graph informado, corresponder ao papel declarado
e participar dos edges aceitos necessários. Edges limítrofes ou bloqueados
nunca são promovidos pela recipe.

A policy `variant-recipe-policy/v1` exige prova para objetivos de venda ou
objetivos desconhecidos. Os objetivos de awareness, distribuição/descoberta de
conteúdo, educação, aquecimento, captação de lead, download, agendamento e
WhatsApp podem produzir a recipe curta. O servidor deriva o objetivo do batch;
o caller não o substitui.

`requireProof=true` pode tornar a decisão mais restritiva. `requireProof=false`
não pode remover uma exigência da policy. Quando a prova é omitida legitimamente,
a recipe registra `PROOF_OMITTED_BY_POLICY` e a evidence da decisão.

## 3. Scores e assumptions

O score da recipe não é uma média otimista simples. A versão
`variant-recipe-score/v1` registra:

- menor edge score;
- média dos edges;
- score ponderado que penaliza o elo mais fraco;
- fit do objetivo;
- completude de lineage;
- score total.

Assumptions possuem código, statement e evidence refs. O hash das assumptions,
da policy, dos scores, do `StoryPlan`, do `EditPlan` e da execução inteira
integra a identidade imutável da recipe.

## 4. Compiler e cold open

O compiler `variant-recipe-compiler/v1` produz:

- `StoryPlan` com três acts e os `StoryBlock`s ordenados;
- `EditPlan` com ranges de frames e source references imutáveis;
- master references deduplicados por artifact;
- lineage primária para cada bloco;
- lineage adicional para cold open, quando presente.

O cold open:

- referencia um node já selecionado;
- usa um subrange contido na fonte;
- possui no máximo dez segundos;
- retorna ao papel `hook` na versão v1;
- preserva `coldOpenHash` e lineage própria;
- não altera nem copia o master.

Hidratação recalcula hashes, ordem, contagens, ranges, roles, scores e
projeções relacionais. Qualquer adulteração é rejeitada.

## 5. Persistência PostgreSQL V2

A migration `20260728030000_variant_recipes` cria:

- `variant_recipe_runs`;
- `variant_recipe_lineage`.

Ela também adiciona a chave composta que vincula uma recipe ao graph, workspace,
project, batch, take library e `runHash` exatos.

Constraints verificam versões, status, contagens, presença de prova, cold open,
scores, hashes SHA-256, JSON, ranges, roles e tipos de uso. Foreign keys impedem
que lineage de uma recipe referencie node de outro graph. A persistência relê
batch, graph e ator em transação serializável antes de gravar.

Depois deste gate, o bootstrap V2 possui 77 tabelas, 381 índices e 274 foreign
keys. O banco isolado com pgvector foi reconstruído do zero, recebeu 66/66
migrations e executou o E2E PostgreSQL/API real integralmente.

## 6. API pública

As três capabilities estão em discovery, OpenAPI, schemas versionados,
exemplos, catálogo de tools, safety policy e contratos de concorrência:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.variant-recipes.list` | `GET /v1/batches/{batchId}/variant-recipes` | `projects:read` |
| `apollo.batches.variant-recipes.create` | `POST /v1/batches/{batchId}/variant-recipes` | `projects:write` |
| `apollo.batches.variant-recipes.read` | `GET /v1/batches/{batchId}/variant-recipes/{recipeId}` | `projects:read` |

Criação exige `Idempotency-Key`, graph ID, graph `runHash`, seleção e ordem
exatas. Replay devolve a execução original. Reutilizar a chave com outro
payload ou informar hash stale retorna conflito.

Depois deste gate, o contrato público possui 124 capabilities, 199 schemas,
231 exemplos e 101 paths, sem regressão do baseline anterior.

## 7. Interface `/batches`

O painel `Recipe slate` apresenta:

- seletor de recipes imutáveis;
- criação pelo mesmo endpoint público usado por clientes externos;
- score total, elo mais fraco, fit do objetivo, duração e masters;
- recipe curta ou com prova;
- cold open e ordem narrativa;
- `ScriptBlock`, take e range de cada lineage entry;
- quantidade de `StoryBlock`s, frames e entries;
- confirmação de que fontes não foram materializadas;
- confirmação de que masters não foram duplicados;
- policy, assumptions e reason codes.

A UI mantém graph, take library e recipe no mesmo contexto. Mudança de batch,
alignment, library ou graph invalida a seleção stale e a idempotency key local.

## 8. Regressões

O conjunto `T-FR-084` cobre:

- recipe completa H+B+proof+CTA;
- recipe curta sem proof somente por policy;
- lineage exata até `ScriptBlock`, take, source segment e artifact;
- `StoryPlan` e `EditPlan` por referência;
- master dedupe;
- cold open e retorno ao hook;
- adulteração de lineage e hashes;
- contrato público estrito;
- objetivo e graph derivados pelo servidor;
- idempotência vinculada ao ator;
- replay, payload conflitante e graph stale;
- foreign key cross-graph e constraints de contagem.

Resultados do commit técnico `0c2c7a8`:

- regressão integral: 539/539;
- testes focados T-FR-084: 7/7;
- integração PostgreSQL/API real: 1/1;
- typecheck: aprovado;
- lint arquitetural V2-only/PostgreSQL/API-first: aprovado;
- schema/migrations: 77 tabelas, 381 índices e 274 foreign keys;
- contratos públicos: 124 capabilities, 199 schemas, 231 exemplos e 101 paths;
- build Next.js remoto: aprovado.

## 9. Evidência de produção

Produção foi validada em 28 de julho de 2026:

- commit e imagem: `0c2c7a8` / `apollo-video:0c2c7a8`;
- archive exato:
  SHA-256 `45d5d6cc43a6f505be60aaf83c9e2adfec13fafb1424088917dfc72b7b69dc73`;
- imagem:
  `sha256:dc01ccdcffef3a9aae0dd23515db29483020b43d749fa0cee13fbf2e2ef229e5`;
- backup pré-migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260728T105455Z.dump`;
- SHA-256 do backup:
  `a64ce0e5aad2c8446f68e5fb9abc234b5ce85a72dc7b8b9f36d19ae9a244064a`;
- `pg_restore --list` aprovado;
- migration `20260728030000_variant_recipes` aplicada;
- 66/66 migrations concluídas;
- app healthy e três workers running;
- quatro restart counts iguais a zero;
- health interno e público HTTP 200.

Smoke pela API pública:

- batch: `compat-prod-batch-6b9f7931`;
- take library:
  `take-library-9ef33c71-2b9d-41a6-8669-e6f37a884805`;
- graph integralmente aceito:
  `compatibility-graph-34163934-c5d9-469a-987c-51c413e84f53`;
- recipe completa com cold open:
  `variant-recipe-fe7da690-c3a3-4a44-87b4-343bfab792ca`;
- recipe curta:
  `variant-recipe-1a9838a9-c9e9-4791-b1ee-39c895f51cea`;
- acesso sem autenticação: HTTP 401;
- criação completa: HTTP 201;
- replay exato: HTTP 200;
- mesma chave com payload diferente: HTTP 409;
- graph hash stale: HTTP 409;
- criação curta: HTTP 201;
- leitura: HTTP 200;
- listagem: HTTP 200;
- três capabilities encontradas;
- recipe completa com cinco lineage entries, prova e cold open;
- recipe curta com três lineage entries e `PROOF_OMITTED_BY_POLICY`;
- zero source materialization e zero master duplication;
- duas execuções e oito lineage rows persistidos pelo smoke;
- foreign key cross-graph e constraint de contagem comprovadas.

Evidência visual em `https://apollo.alpesd.com.br/batches`:

- versão `0c2c7a8` visível;
- recipes completa e curta selecionáveis;
- cold open, prova, scores, lineage e compiler integrity visíveis;
- ação `Compilar outra` concluiu POST HTTP 201;
- recipe criada pela UI:
  `variant-recipe-ac33c935-7a3c-4970-a5af-283334c6fbbb`;
- desktop 1440 × 1000 sem overflow;
- mobile 390 × 844 com document width de 382 px e painel dentro da viewport;
- zero caracteres Unicode de substituição;
- zero percentuais malformados;
- zero erros ou warnings de console;
- screenshots locais:
  `output/playwright/f2011-production-variant-recipe-desktop.png`,
  `output/playwright/f2011-production-variant-recipe-panel-mobile.png` e
  `output/playwright/f2011-production-ui-created-recipe-desktop.png`.

Após o smoke e a ação da UI, o graph possuía três recipes e doze lineage rows.
App e workers permaneceram com zero reinícios.

## 10. Limite honesto deste gate

F2.011 escolhe e compila uma recipe individual. Ele ainda não calcula o
portfólio limitado de todas as recipes elegíveis, não estima a matriz completa
de outputs/custo/tempo/reuso e não exige confirmação para expansão acima do
default do workspace.

Essas responsabilidades pertencem à F2.012. A existência de uma recipe não
autoriza materializar o produto cartesiano nem criar jobs pagos.
