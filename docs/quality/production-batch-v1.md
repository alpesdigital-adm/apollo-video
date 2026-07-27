# F2.007 — ProductionBatch v1

## 1. Resultado do slice

Este gate entrega a unidade operacional de produção em lote do Apollo V2.
Um `ProductionBatch` agrupa fontes autorizadas, receitas, formatos e somente
as saídas que o usuário ou agente escolheu explicitamente.

O slice inclui:

- modelo de domínio e persistência PostgreSQL V2;
- estado independente por item e por etapa;
- custo, erro, retry, cache e artefatos por item;
- progresso agregado calculado exclusivamente a partir das etapas persistidas;
- cancelamento e retomada do lote sem apagar trabalho concluído;
- retry isolado da etapa que falhou;
- API pública completa para criação, leitura, listagem e ações;
- interface responsiva `/batches`;
- E2E real por HTTP, PostgreSQL e navegador;
- contratos para operação externa por agentes e outras ferramentas.

Não existe caminho paralelo, tabela antiga, fallback em memória ou endpoint
privado para essa funcionalidade. A UI usa as mesmas rotas `/v1` expostas aos
clientes externos.

## 2. Aggregate e matriz explícita

O aggregate persiste:

- identidade, workspace, projeto e revisão;
- versão do schema e da policy;
- nome e objetivo;
- source groups com os artefatos de origem;
- recipes com os source groups permitidos;
- variants com formato e locale;
- budget, reserva e custo consumido;
- items escolhidos;
- status agregado;
- hash da definição, fingerprint e ator.

Receitas e variantes descrevem as possibilidades, mas não criam outputs por
produto cartesiano. Cada item precisa declarar exatamente:

- `sourceGroupId`;
- `recipeId`;
- `variantId`;
- uma chave lógica única no lote.

Assim, duas receitas e dois formatos representam quatro combinações possíveis,
mas um request pode materializar somente três items. O smoke de produção
comprovou exatamente esse caso.

O domínio recusa:

- fonte ausente do source group;
- recipe apontando para source group inexistente;
- item apontando para recipe ou variant inexistente;
- recipe incompatível com o source group do item;
- dimensões incompatíveis com o output spec;
- chaves e combinações duplicadas;
- orçamento inválido ou reserva acima do teto;
- definição ou estado adulterados.

## 3. Estado independente e progresso verdadeiro

Cada item possui quatro etapas ordenadas:

1. `planning`;
2. `materializing`;
3. `rendering`;
4. `reviewing`.

Cada etapa registra independentemente:

- estado;
- attempt;
- custo em minor units;
- cache hit;
- erro tipado e mensagem limitada;
- hash;
- data da última transição.

O item registra ainda revisão, retry count, erro terminal e artefatos anexados
em ordem. O vínculo com `media_artifacts` é relacional e preserva a linhagem;
cancelar, retomar ou retentar nunca apaga artefatos de etapas já concluídas.

O progresso do lote é derivado da soma das etapas:

- total;
- queued;
- running;
- completed;
- failed;
- cancelled;
- percentual;
- custo gasto.

Nenhum percentual informado pelo cliente é aceito. O status agregado é
recalculado a partir dos items e pode ser `queued`, `running`, `review`,
`partially-completed`, `completed`, `failed` ou `cancelled`.

## 4. Transições, retry e concorrência

As ações de item são:

- `start-step`;
- `complete-step`;
- `fail-step`;
- `cancel`;
- `resume`;
- `retry-step`.

O retry reabre somente a etapa falha selecionada, incrementa a tentativa e
preserva custo e artefatos anteriores. Um cache hit não cobra novamente o
custo informado pela execução. Etapas posteriores não podem avançar antes dos
pré-requisitos.

As ações de lote são `cancel` e `resume`. Elas afetam apenas trabalho não
concluído:

- item concluído permanece concluído;
- artefato concluído permanece vinculado;
- item em aberto passa para cancelado;
- resume reabre somente items não concluídos;
- custo já gasto permanece contabilizado.

Toda mutation exige `Idempotency-Key`. A criação é idempotente pelo ator e
fingerprint. As ações exigem `expectedBatchRevision` e, quando atingem um item,
`expectedItemRevision`. O repositório usa transação serializável, compare and
swap e retry limitado para conflitos do PostgreSQL.

## 5. Persistência PostgreSQL V2

A migration `20260727200000_production_batches` cria:

- `production_batches`;
- `production_batch_items`;
- `production_batch_steps`;
- `production_batch_item_artifacts`;
- `production_batch_actions`.

Constraints verificam status, revisões, hashes, JSON canônico, custos,
tentativas, coerência de erros, cache, datas e relações entre workspace,
projeto, cliente, batch, item e artefato.

Índices cobrem:

- listagem estável por workspace, status, projeto e objetivo;
- idempotência por ator;
- chave e combinação únicas por item;
- busca de items por estado, recipe e variant;
- etapas por estado e sequência;
- artefatos e ações por lote ou item.

Os nomes físicos do SQL foram comparados com o diff determinístico do Prisma.
O verificador aprovou o schema completo com 68 tabelas, 332 índices e 239
foreign keys.

## 6. API pública

As cinco capabilities estão no discovery, OpenAPI, schemas versionados,
exemplos, regras de segurança e catálogo de tools:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.list` | `GET /v1/batches` | `projects:read` |
| `apollo.batches.create` | `POST /v1/batches` | `projects:write` |
| `apollo.batches.read` | `GET /v1/batches/{batchId}` | `projects:read` |
| `apollo.batches.actions.apply` | `POST /v1/batches/{batchId}/actions` | `projects:write` |
| `apollo.batches.items.actions.apply` | `POST /v1/batches/{batchId}/items/{itemId}/actions` | `projects:write` |

Listagem suporta projeto, status, busca textual, cursor opaco e limite. O
cursor é vinculado aos filtros e ao workspace. O workspace nunca é recebido
no body; ele vem da credencial Bearer ou da sessão humana.

As respostas públicas incluem estado necessário para operação externa, mas
não expõem fingerprint, idempotency key, chaves de storage ou detalhes de
transação.

## 7. Interface `/batches`

A tela é um control room de produção em lote e oferece:

- lista e filtro por texto/status;
- resumo de lotes em produção, review e atenção;
- criação por projeto e materiais com direitos aprovados;
- receitas editáveis;
- escolha de formatos;
- matriz receita × formato com seleção explícita por célula;
- budget;
- detalhe de cada item e sua trilha de etapas;
- progresso e custo reais;
- erros, attempts, cache e artefatos;
- cancelamento e retomada;
- ações individuais e em massa;
- navegação desktop e mobile.

Materiais indisponíveis ou sem direitos aprovados aparecem bloqueados e não
podem ser enviados. A tela não chama repository, Prisma ou código aposentado;
usa somente `/v1/projects`, `/v1/projects/{id}/workspace` e `/v1/batches`.

O lint arquitetural varre todo TSX em `src/app` e impede imports de uma raiz
antiga ou acesso direto a `@prisma/client`.

## 8. Evidência automatizada local

O banco isolado `apollo_video_v2_e2e_batches` foi destruído e recriado no
PostgreSQL 16 da VPS. As extensões `vector`, `pg_trgm` e `pgcrypto` foram
pré-criadas pelo administrador, e as 61 migrations foram aplicadas do zero.

Resultados:

- schema Prisma válido;
- 68 tabelas, 332 índices e 239 foreign keys reconhecidos;
- E2E API/PostgreSQL `T-FR-080`: 1/1, 57,5 s;
- regressão integral: 519/519;
- typecheck: aprovado;
- lint V2-only: aprovado;
- contratos: 110 capabilities, 181 schemas, 213 exemplos e 91 paths;
- build Next.js 16.2.12: aprovado;
- auditoria npm do app: zero vulnerabilidades;
- auditoria npm do renderer: zero vulnerabilidades.

O E2E persistiu três items e doze etapas, então comprovou:

- um item completo com artifact final;
- um item com artifact intermediário e falha de provider;
- um item cancelado;
- status `partially-completed`;
- 5 etapas concluídas, 1 falha, 4 canceladas e progresso de 41%;
- custo gasto de 9 minor units;
- retry somente de `materializing`;
- attempt incrementada para 2;
- cache hit sem nova cobrança;
- conflito de revisão antiga em HTTP 409;
- cancelamento e retomada preservando item completo, artefatos e custo;
- constraints SQL recusando status e erro incoerentes.

O E2E visual local criou uma matriz 2 × 2 com somente três células marcadas,
validou seleção em massa, cancelamento, retomada, filtro, desktop e mobile,
sem erro de console.

## 9. Evidência de produção

Produção foi validada em 2026-07-27:

- commit e imagem: `f44395d` / `apollo-video:f44395d`;
- archive exato do commit:
  SHA-256 `8ab7e2ec34daf81c0048a1f6daf4889b45af1fdb179db7349ada3d9ac4c2e9f1`;
- imagem:
  `sha256:68315ccbd3b7484e8c96e4427c4fc049669a1ff1f08d0f3e65b518ce8d767afa`;
- backup pré-migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260727T203909Z.dump`;
- SHA-256 do backup:
  `eff00dac7ab03ac0bae44a97e9e57d687e179cd82b19964f40a77b7072b9c319`;
- `pg_restore --list` aprovado;
- migration `20260727200000_production_batches` aplicada;
- 61/61 migrations concluídas;
- app, ingest, render e webhook usam o mesmo digest;
- app healthy, três workers running e quatro restart counts iguais a zero;
- health público HTTP 200;
- listagem sem autenticação recusada em HTTP 401;
- cinco capabilities de lote presentes na descoberta autenticada.

Smoke externo no projeto de teste:

- projeto:
  `project-fe932791-32f4-4453-8b85-6ce35a711860`;
- fonte aprovada:
  `artifact-89a72429c007-3405acad6ec8718c6742f4db21bcdb818b4f41eb8140f0fc91f18dfe2e7f8ada`;
- batch:
  `production-batch-c9f53905-8c22-4710-92c2-e1f61423037d`;
- criação HTTP 201;
- leitura HTTP 200;
- duas recipes × duas variants, mas somente três items persistidos;
- doze etapas persistidas;
- cancelamento: `cancelled`, revisão 2;
- retomada: `queued`, revisão 3.

E2E visual em `https://apollo.alpesd.com.br/batches`:

- batch e três saídas visíveis;
- detalhe mostra duas recipes, dois formatos, custo e progresso reais;
- versão `f44395d` visível discretamente;
- desktop sem erro ou warning de console;
- mobile 390 × 844 sem overflow horizontal;
- zero caracteres Unicode de substituição;
- screenshots locais:
  `output/playwright/production-batches-prod-f44395d-clean.png` e
  `output/playwright/production-batches-prod-f44395d-mobile.png`.

## 10. Limite honesto deste gate

F2.007 coordena e observa os items, mas não afirma que todos os tipos futuros
de recipe já possuem executor. Os workers e providers dos próximos gates
usarão a ação pública de item para avançar as mesmas quatro etapas.

Este slice também não marca FR-081 a FR-087 como um conjunto completo. Ele
entrega somente o fundamento de `ProductionBatch` e a parte de retry necessária
para manter cada item independente. Importação de roteiro, biblioteca de takes,
compatibility graph, recipes avançadas e propagação de edição continuam nos
gates seguintes.
