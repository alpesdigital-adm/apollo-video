# F2.013 — Edição em lote v1

## 1. Resultado do slice

Este gate entrega edição em lote explícita e transacional sobre
`ProductionBatch`. O Apollo V2 agora permite escolher exatamente:

- quais recipes participam;
- quais formatos participam;
- quais batch items são targets;
- qual operação será aplicada;
- se conflitos abortam tudo (`all-or-nothing`) ou são pulados
  (`skip-failures`).

Antes de qualquer alteração, a API cria um preflight imutável com impacto,
conflitos protegidos, invalidações, custo e diff amostrado. O commit só aceita
um token temporário assinado para aquele ator, workspace, batch, escopo,
estado, custo e expiração. Depois do commit, o resultado de cada item e cada
invalidação permanecem consultáveis.

As três operações iniciais são `replace-cta`, `subtitle-style` e `brand-kit`.
Não existe caminho interno privilegiado: a interface `/batches`, integrações
externas e agentes usam os mesmos application services e contratos `/v1`.

## 2. Seleção explícita e escopo imutável

O caller precisa enviar listas não vazias de `recipeIds`, `outputSpecIds` e
`itemIds`. O servidor verifica cada target contra o batch atual e rejeita:

- recipe ausente ou que não pertença ao item;
- formato ausente ou diferente da variant do item;
- item de outro batch ou workspace;
- item repetido;
- seleção vazia ou acima do limite da policy;
- revisão ou `definitionHash` stale;
- qualquer campo inesperado no contrato.

O escopo normalizado possui hash canônico. O commit reapresenta
`expectedScopeHash`; não existe confirmação booleana ou seleção implícita
controlada pela interface.

Na UI, o painel `Batch edit desk` organiza a escolha em três passos visíveis:
recipes, formatos e targets. O usuário vê a quantidade selecionada em cada
etapa antes de solicitar o preflight.

## 3. Impact preview

Cada `BatchEditPreflightRun` registra:

- operação e valor de destino;
- modo transacional;
- estado e revisão anteriores de cada item;
- target semântico exato;
- conflitos e reason codes;
- steps e target refs invalidados;
- custo estimado por item e total;
- orçamento restante;
- `sampleDiff` limitado pela policy;
- contagens de aplicáveis, protegidos e sem mudança;
- hashes de impacto, custo, escopo e preflight;
- validade da confirmação.

O preview tem estado `ready`, `partial-ready`, `blocked` ou `no-change`.
`all-or-nothing` fica bloqueado se um único target possuir conflito protegido.
`skip-failures` pode ficar parcialmente pronto, mas precisa listar exatamente
quais itens serão aplicados e quais serão pulados. Orçamento insuficiente
bloqueia antes do commit.

## 4. Transação e concorrência

O commit roda em transação PostgreSQL `Serializable`. O token HMAC está
vinculado a API client, workspace, batch, revisão, `definitionHash`,
preflight, scope hash, fingerprint de custo e expiração.

Antes de persistir, o servidor relê batch, policy e todos os estados atuais.
Qualquer drift produz conflito explícito; não há last-write-wins.

Em `all-or-nothing`, nenhum estado muda se um item não puder ser aplicado. Em
`skip-failures`, somente itens previamente classificados como aplicáveis são
alterados. A mesma `Idempotency-Key` e o mesmo payload repetem o command
original; reutilizar a chave com outro payload falha.

## 5. Resultado por item e invalidação

`BatchEditCommand` contém um `resultItem` para cada target solicitado. Cada
resultado registra status, recipe, variant, output spec, target, revisão/hash
antes e depois, conflitos, invalidações, custo e hash do resultado.

Estados editoriais são append-only em
`batch_edit_item_state_versions`. O commit não apaga artifacts nem enfileira
renders silenciosamente. Em vez disso, persiste a próxima obrigação de
trabalho em `batch_edit_invalidations`:

| Operação | Steps invalidados por item |
|---|---|
| CTA | planning, materializing, rendering, reviewing |
| Legenda | rendering, reviewing |
| Brand Kit | materializing, rendering, reviewing |

Essa separação permite que o gate seguinte reenfileire apenas o step falho ou
stale, sem refazer itens válidos.

## 6. Persistência PostgreSQL V2

A migration `20260728070000_batch_edits` cria:

- `batch_edit_policies`;
- `batch_edit_item_state_versions`;
- `batch_edit_preflight_runs`;
- `batch_edit_commands`;
- `batch_edit_command_items`;
- `batch_edit_invalidations`.

Foreign keys carregam workspace e batch no relacionamento para impedir
referências cruzadas. Constraints verificam versões, enumerações, contagens,
datas, custo, JSON, hashes, estados agregados e relações entre resultado,
aplicação e invalidação.

O hydrator não confia apenas em contagens: ele recalcula e compara cada
invalidação persistida, inclusive workspace, batch, command, item, step,
sequência, target ref, timestamp e hash. O E2E altera deliberadamente um target
persistido, recebe `PERSISTENCE_CONFLICT` e restaura a linha.

O schema do produto possui 85 tabelas de domínio, 416 índices e 310 foreign
keys. O PostgreSQL inclui ainda `_prisma_migrations`, totalizando 86 tabelas no
schema físico de produção.

## 7. API pública

Seis capabilities novas estão em discovery, OpenAPI, schemas versionados,
exemplos, safety policy e auditorias de concorrência/precondição:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.edit-preflights.list` | `GET /v1/batches/{batchId}/edit-preflights` | `projects:read` |
| `apollo.batches.edit-preflights.create` | `POST /v1/batches/{batchId}/edit-preflights` | `projects:write` |
| `apollo.batches.edit-preflights.read` | `GET /v1/batches/{batchId}/edit-preflights/{preflightId}` | `projects:read` |
| `apollo.batches.edit-preflights.commit` | `POST /v1/batches/{batchId}/edit-preflights/{preflightId}/commit` | `projects:write` |
| `apollo.batches.edit-commands.list` | `GET /v1/batches/{batchId}/edit-commands` | `projects:read` |
| `apollo.batches.edit-commands.read` | `GET /v1/batches/{batchId}/edit-commands/{commandId}` | `projects:read` |

Depois deste gate, o contrato público possui 133 capabilities, 211 schemas,
243 exemplos e 108 paths, mantendo o baseline compatível.

## 8. Regressões e E2E antes do deploy

`T-FR-086` cobre seleção exata, as três operações, diff, orçamento,
no-change, conflito protegido atômico, modo parcial, token assinado, replay,
stale state, adulteração persistida, resultado/invalidação por item,
listagem/leitura, autenticação, autorização, concorrência, precondições e
constraints relacionais.

Resultados do commit técnico:

- regressão integral: 549/549;
- integração API/PostgreSQL real: 1/1;
- PostgreSQL isolado reconstruído com 68 migrations;
- build Next.js de produção: aprovado;
- typecheck: aprovado;
- lint arquitetural: somente runtime PostgreSQL/API-first;
- linguagem canônica: aprovada;
- schema/migrations: 85 tabelas, 416 índices e 310 foreign keys;
- contratos: 133 capabilities, 211 schemas, 243 exemplos e 108 paths;
- auditoria npm do app e Remotion: zero vulnerabilidades;
- `git diff --check`: aprovado.

## 9. Evidência visual

O painel foi exercitado no build exato antes do deploy:

- preview de legenda com três targets;
- commit 3/3;
- resultado individual de cada target;
- desktop 1440 × 1000 sem overflow;
- mobile 390 × 844 sem overflow;
- zero caracteres Unicode de substituição;
- zero erros ou warnings de console.

Screenshots não versionadas:

- `output/playwright/f2013-batch-edit-panel-desktop.png`;
- `output/playwright/f2013-batch-edit-result-desktop.png`;
- `output/playwright/f2013-batch-edit-panel-mobile.png`.

Uma regressão impede que o painel volte a ficar aninhado na seção de
alinhamento: ele pertence à área `Saídas do lote` e aparece mesmo quando não
existe transcript.

Em produção, a tela de login exibiu discretamente
`Apollo · v1.0.0 · 9a2f436` e não gerou erro de console. A credencial humana não
foi rotacionada para o teste; a prova funcional autenticada em produção foi
feita pela API Bearer externa, enquanto a prova visual usa o mesmo source e
build revision que geraram a imagem implantada.

## 10. Evidência de produção

Produção foi validada em 28 de julho de 2026:

- commit técnico/build revision: `9a2f436`;
- imagem: `apollo-video:9a2f436`;
- digest comum ao app e aos três workers:
  `sha256:b15e4b5d5a7405c830e18b03caef7a25a21d495586edc507a0a705f5136811f2`;
- archive exato:
  SHA-256 `b8e152d206abd675d5fe4ca790cffa0cb7d2b28a943f4119b372ae67e0a526c3`;
- backup:
  `/opt/backups/apollo-video/apollo_video_v2-20260728T141449Z.dump`;
- SHA-256 do backup:
  `a897e625d47ece8b867cf8bd7eb9427227279187211f557af99937f3757ba0dc`;
- `pg_restore --list`: aprovado;
- migration `20260728070000_batch_edits`: aplicada;
- 68/68 migrations concluídas e zero pendentes;
- app healthy e três workers running;
- quatro `APOLLO_BUILD_REVISION=9a2f436`;
- quatro restart counts iguais a zero;
- health público HTTP 200;
- preflight sem autenticação HTTP 401.

Smoke externo no batch
`production-batch-c9f53905-8c22-4710-92c2-e1f61423037d`:

| Operação | Preflight | Command | Itens | Invalidações | Custo |
|---|---|---|---:|---:|---:|
| CTA | `batch-edit-preflight-f2d19aad-5198-4652-85c7-8bd55a26dcd1` | `batch-edit-command-c4062da4-06fd-4aa9-835d-0fed87669a73` | 3/3 | 12 | 375 |
| Legenda | `batch-edit-preflight-1853744d-ba89-45aa-aa09-8cabbf7edde1` | `batch-edit-command-21b2f9e6-e0bd-4126-b25a-25c2acd0d353` | 3/3 | 6 | 75 |
| Brand Kit | `batch-edit-preflight-0d69e9e6-7a58-4a85-9d7d-181a782cbeb3` | `batch-edit-command-0f780777-47b7-4fc9-adf5-f0bddcc3650f` | 3/3 | 9 | 225 |

Todas as criações iniciais retornaram sucesso, nenhum item foi pulado e a
segunda execução retornou os mesmos IDs com
`previewReplayed=true`/`commitReplayed=true`.

Projeção relacional do smoke:

- 3 preflights;
- 3 commands;
- 9 command items;
- 27 invalidations;
- 12 versões de estado;
- 74 constraints nas seis tabelas do gate.

## 11. Limite honesto deste gate

F2.013 aplica mudanças e persiste as invalidações necessárias. Ele não executa
automaticamente o trabalho invalidado e não promete retry seletivo.

Reenfileirar somente provider/render/validator falho, preservar artifacts
válidos e recalcular custo com cache pertencem ao F2.014.
