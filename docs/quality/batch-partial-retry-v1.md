# F2.014 — Partial retry v1

## 1. Resultado do slice

Este gate entrega retry parcial durável para `ProductionBatch`. Uma chamada
seleciona de um a cem itens falhos e reapresenta, para cada target, o step, a
revisão do item e o hash exato do step falho. O servidor rejeita o comando
inteiro se qualquer uma dessas precondições estiver stale.

Somente os targets confirmados voltam para `queued`. Itens concluídos, steps
anteriores e artifacts válidos permanecem inalterados. O enqueue não consome
orçamento e um resultado posterior marcado como cache hit também não adiciona
custo.

O fluxo implementado pertence exclusivamente ao runtime V2:

- fonte de verdade PostgreSQL V2;
- application service único para UI e integrações;
- contratos externos `/v1`;
- idempotência obrigatória;
- nenhuma ponte, fallback ou compatibilidade com pipeline antigo.

## 2. Manifesto de retry e lineage

Cada comando produz um `BatchPartialRetryRun` imutável e um
`BatchPartialRetryJob` por target. O manifesto registra:

- workspace, projeto, batch, item e step;
- revisão do batch antes e depois;
- hash da definição do batch;
- executor responsável: director, provider, renderer ou validator;
- tentativa falha e próxima tentativa;
- hash do step falho e do novo step enfileirado;
- código e mensagem da falha;
- artifacts preservados;
- progresso e orçamento antes e depois;
- cliente, instante, hashes do job e do manifesto.

O `lineageKey` canônico não depende do ID do retry. Ele é derivado de
workspace, batch, hash da definição, item e step. Por isso, a segunda tentativa
do mesmo renderer conserva a lineage da primeira enquanto avança de tentativa
2 para 3.

## 3. Concorrência, atomicidade e idempotência

O comando exige simultaneamente:

- `expectedBatchRevision`;
- `expectedItemRevision` de cada target;
- `expectedStepHash` de cada falha;
- `Idempotency-Key` externa.

O repositório relê e recompila o agregado dentro de uma transação PostgreSQL
`Serializable`. A atualização do batch, o action manifest e todos os retry jobs
são persistidos na mesma transação. Não existe enqueue parcial: se um target
estiver stale, nenhum target é alterado.

A repetição da mesma chave e payload devolve exatamente o retry persistido.
Reutilizar a chave com outro target falha com
`IDEMPOTENCY_PAYLOAD_MISMATCH`. Uma nova chave baseada na revisão antiga falha
com `VERSION_CONFLICT`.

## 4. Preservação e custo

Antes e depois do enqueue, o domínio recalcula `ProductionBatchProgress` e
exige:

- custo gasto idêntico;
- orçamento restante idêntico;
- todos os itens concluídos ainda concluídos;
- todos os artifacts válidos ainda referenciados;
- somente os steps falhos selecionados em `queued`.

Cada job possui `chargedMinorUnitsAtEnqueue: 0`, reforçado no domínio, no
hydrator e por constraint PostgreSQL. Ao completar o retry com
`cacheHit: true`, qualquer custo nominal informado é ignorado e o gasto do
batch não muda.

## 5. Persistência PostgreSQL V2

A migration `20260728090000_batch_partial_retries`:

- adiciona o manifesto e seu hash a `production_batch_actions`;
- inclui `partial-retry` no conjunto válido de batch actions;
- cria `production_batch_retry_jobs`;
- relaciona jobs a workspace, projeto, batch, item e action;
- impede repetição de item/step no mesmo action;
- impede repetição de tentativa na mesma lineage;
- valida executor por step, estado, tentativas, hashes, artifacts e custo zero;
- cria índices para leitura por batch e consumo por executor.

O hydrator cruza o JSON canônico com as linhas relacionais. Adulterar executor,
tentativa, lineage, artifacts ou hashes faz a leitura falhar fechada com
`PERSISTENCE_CONFLICT`.

Depois deste gate, o schema validado possui 86 tabelas de domínio, 422 índices
e 315 foreign keys. Produção contém 69 migrations concluídas.

## 6. API pública e interface

As três capabilities novas estão no discovery, OpenAPI, schemas versionados,
exemplos e safety policy:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.partial-retries.list` | `GET /v1/batches/{batchId}/partial-retries` | `projects:read` |
| `apollo.batches.partial-retries.create` | `POST /v1/batches/{batchId}/partial-retries` | `projects:write` |
| `apollo.batches.partial-retries.read` | `GET /v1/batches/{batchId}/partial-retries/{retryId}` | `projects:read` |

O contrato público possui 136 capabilities, 215 schemas, 247 exemplos e 110
paths. O parser aceita somente `expectedBatchRevision` e `targets`, e cada
target aceita somente item, step, revisão e hash esperados.

Na área de saídas do lote, o painel `Recovery rail` lista falhas, executor e
tentativa, mostra itens/artifacts preservados e permite reenfileirar todas as
falhas atuais usando exclusivamente a rota pública acima. Uma requisição de
resultado incerto conserva a mesma chave idempotente.

## 7. Regressões e E2E antes do deploy

Resultados do commit técnico `ea60bb7`:

- regressão integral: 554/554;
- teste estrutural da UI de lote: 11/11;
- integração API/PostgreSQL real: 1/1 em aproximadamente 292 segundos;
- PostgreSQL isolado reconstruído com 69/69 migrations;
- build Next.js de produção: aprovado;
- typecheck: aprovado;
- lint arquitetural: somente runtime PostgreSQL/API-first;
- linguagem canônica: aprovada;
- contratos públicos: aprovados e baseline compatível;
- schema/migrations: 86 tabelas, 422 índices e 315 foreign keys;
- auditoria npm do app e do Remotion: zero vulnerabilidades;
- `git diff --check`: aprovado.

O E2E misto comprova:

- um item completamente concluído;
- falha de provider em materialização;
- falha de renderer em render;
- falha de validator em revisão;
- retry atômico dos três executores;
- replay e payload mismatch;
- rejeição de revisão e step hash stale;
- leitura e paginação;
- preservação do item concluído e dos artifacts;
- cache hit sem custo;
- segunda falha do renderer com lineage estável e tentativas 2/3;
- rejeição por constraint de cobrança no enqueue;
- leitura fail closed após adulteração relacional controlada.

## 8. Evidência de produção

Produção foi validada em 28 de julho de 2026:

- commit técnico/build revision: `ea60bb7`;
- imagem: `apollo-video:ea60bb7`;
- digest comum ao app e aos três workers:
  `sha256:2519d3687af3e8e93d9e8081dbf6c03ca79ace068b6efe5bf00eaa4dac5616cb`;
- archive exato:
  SHA-256 `92416951f5ee19c9b66cf0988a1c58b548859a1d3c39f5b271c5381a41f85ee1`;
- backup:
  `/opt/backups/apollo-video/apollo_video_v2-20260728T154222Z.dump`;
- SHA-256 do backup:
  `6cdf8e63897843fadadbba26f5a4d05c131e635c1309b3f2bebf2382302824dd`;
- backup com 1.121.863 bytes e 1.006 entradas válidas no catálogo do
  `pg_restore`;
- migration `20260728090000_batch_partial_retries` aplicada;
- 69/69 migrations concluídas e zero falhas;
- app healthy e três workers running;
- quatro `APOLLO_BUILD_REVISION=ea60bb7`;
- digest idêntico e restart count zero nos quatro runtimes;
- health público HTTP 200;
- zero erros nos logs após o deploy;
- tela de login HTTP 200 exibindo discretamente a revisão `ea60bb7`.

O smoke externo criou o batch
`production-batch-1cc8eb86-e588-4eb8-a7fe-a6027ff80224` e os retries:

- `production-batch-partial-retry-22a32503-5b16-4778-a281-c35630b33cba`;
- `production-batch-partial-retry-12c34a9c-6d02-4622-ab3b-4a861d8405d9`.

Resultados observados:

| Prova | Resultado |
|---|---|
| Executores do retry misto | provider, renderer, validator |
| Tentativas consecutivas do renderer | 2, 3 |
| Lineage do renderer | estável |
| Gasto antes/depois do enqueue | 19 / 19 |
| Delta de custo do cache hit | 0 |
| Item concluído | preservado |
| Artifact existente | preservado |
| Sem autenticação | HTTP 401 |
| Replay idempotente | HTTP 200 |
| Payload mismatch | HTTP 409 |
| Revisão stale | HTTP 409 |

Projeção relacional do smoke:

- 2 partial retry actions;
- 4 retry jobs;
- provider 1, renderer 2 e validator 1;
- todos os jobs em `queued`;
- todos com custo de enqueue zero;
- todos os manifestos válidos;
- 13 constraints na tabela de jobs.

## 9. Limite honesto deste gate

F2.014 reenfileira trabalho de um batch já decomposto e em execução. Ele não
identifica automaticamente quais trechos de um Reel publicado são essenciais
nem detecta legenda queimada, watermark ou overlay. Essas capacidades pertencem
respectivamente a F2.015 e F2.016.
