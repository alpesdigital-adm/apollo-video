# F2.020 — Integrity gate de prova v1

## Resultado entregue

O Apollo V2 agora avalia cada uso de prova selecionada contra a
`VariantRecipe`, o `ProofNeedRun`, o `CompatibilityGraph`, o
`EvidenceSegment` e a autorização atuais antes de liberar a montagem.

O resultado é append-only, canônico e fail-closed:

- `approved`: a prova pode seguir para a montagem;
- `blocked`: existe issue hard e a montagem não pode usar a prova;
- `not-applicable`: o ProofNeed declarou `no-proof-needed`.

O gate permanece virtual. Ele não cria artifact, não chama provider, não
renderiza e não escolhe o modo visual da prova.

## Bindings de entrada

Cada execução `proof-integrity-run/v1` conserva:

- workspace, projeto e batch;
- ID e hash exatos da `VariantRecipe`;
- ID e hash exatos do `ProofNeedRun`;
- ID, node hash e context hash do node usado pela recipe;
- ID e hash do item de ProofNeed;
- ID e hash do `EvidenceSegment` selecionado;
- range de contexto e adjacências que a montagem pretende usar;
- API client, timestamp, request fingerprint e idempotency key.

Pessoa e período são claims estruturados da recipe:

- `integrity.person`;
- `integrity.period`.

O gate não extrai esses valores de copy livre. Se a recipe não os declarar,
ele bloqueia a prova com `RECIPE_PERSON_UNSPECIFIED` ou
`RECIPE_PERIOD_UNSPECIFIED`.

## Matriz de integridade

| Dimensão | Esperado | Atual | Regra de aprovação |
| --- | --- | --- | --- |
| claim | claim do node para o `claimId` | claim do EvidenceSegment | igualdade normalizada exata |
| product | `offerId` da recipe | `compatibleOfferIds` | oferta esperada deve estar permitida |
| person | `integrity.person` | subject | igualdade normalizada exata |
| period | `integrity.period` | qualifier `period:*` | exatamente um período correspondente |
| audience | audience tags da recipe | compatible audience tags | todos os esperados devem estar presentes |
| rights | `approved` | snapshot atual | snapshot atual, aprovado e não expirado |
| consent | conforme tipo de prova | snapshot atual | aprovado; demonstração também aceita `not-required` |
| context | range e adjacências catalogados | uso solicitado | range integral e todas as adjacências |

Normalização remove apenas diferenças superficiais de caixa, acento e espaços.
Ela não usa similaridade semântica para aproximar claims, pessoas ou períodos.

## Contexto e apresentação

Qualquer qualifier torna o EvidenceSegment `context-required`. Uma aprovação
exige que o uso inclua todo o `contextRangeMs` e cada
`adjacentEvidenceId` obrigatório.

Quando aprovado, o gate publica `proof-integrity-presentation/v1`:

- attribution exata;
- qualifiers exatos;
- range de contexto obrigatório;
- adjacências obrigatórias;
- cópias visual e verbal idênticas;
- `mandatory=true` nos dois modos.

Layout, posição, duração e modo serão decididos pelo F2.021. Essa etapa pode
estilizar o contrato, mas não pode omitir ou reescrever attribution e
qualifiers.

## Issues e ausência de fabricação

Toda avaliação bloqueada emite `PROOF_INTEGRITY_BLOCKED`, severity `hard`,
reason codes determinísticos e somente ações previamente permitidas:

- `add-structured-recipe-context`;
- `select-compatible-existing-evidence`;
- `restore-required-evidence-context`;
- `renew-rights-or-consent`.

Nenhuma ação contém geração, fabricação ou estimativa de prova.
`fabricationSuggested=false` existe:

- na avaliação;
- na issue;
- no resumo do run;
- no JSON canônico;
- nas projeções relacionais;
- nas constraints PostgreSQL;
- no schema público e na interface.

`proof-unavailable` gera bloqueio explícito. `no-proof-needed` gera
`not-applicable`; ele não libera a inserção oportunista de uma evidência.

## Persistência e concorrência

A migration `20260729140000_proof_integrity_runs` cria:

- `proof_integrity_runs`;
- `proof_integrity_evaluations`;
- chave composta adicional para vincular a avaliação ao item exato do
  ProofNeed;
- FKs para workspace, projeto, batch, recipe, ProofNeed, API client e
  EvidenceSegment;
- índices para recipe, ProofNeed, outcome, readiness e paginação;
- constraints de versão, contagem, coerência de outcome, pares JSON/hash,
  ausência de fabricação e apresentação obrigatória em aprovações.

A criação ocorre em transação serializável. Imediatamente antes do commit, o
repositório revalida:

- API client ativo;
- ProofNeed ID/hash, recipe, batch e projeto;
- item ID/hash, resolução e evidência selecionada;
- recipe ID/hash e CompatibilityGraph;
- node ID/hash/context hash;
- EvidenceSegment ID/hash;
- snapshot atual, rights, consent e estado de expiração observado.

Conflitos serializáveis possuem retry limitado. Replay com o mesmo ator, chave
e payload converge; a mesma chave com payload diferente falha.

A hidratação recalcula hashes de run, avaliação, recipe context, presentation e
issue, além de comparar todas as projeções relacionais. JSON não canônico ou
projeção divergente falha como conflito de persistência.

## API pública

| Capability | Método e rota | Escopo |
| --- | --- | --- |
| `apollo.projects.proof-integrity-runs.list` | `GET /v1/projects/{projectId}/proof-integrity-runs` | `projects:read` |
| `apollo.projects.proof-integrity-runs.create` | `POST /v1/projects/{projectId}/proof-integrity-runs` | `projects:write` |
| `apollo.projects.proof-integrity-runs.read` | `GET /v1/projects/{projectId}/proof-integrity-runs/{runId}` | `projects:read` |

A listagem filtra por ProofNeed, recipe, outcome e readiness. Todas as
operações estão no capability discovery, OpenAPI, schemas versionados, exemplos
e catálogo de ferramentas para agentes.

A criação é bounded, idempotente, aceita no máximo dezesseis usos e não inicia
trabalho externo.

## Interface

O painel “Integridade editorial” consome exclusivamente a API `/v1`. Para cada
execução, ele mostra:

- readiness da montagem;
- contagens aprovada/bloqueada;
- um trilho com as oito dimensões;
- crédito e qualifiers obrigatórios;
- confirmação de paridade entre tela e fala;
- issue e ações corretivas;
- confirmação explícita de que fabricação nunca foi sugerida.

Não existe leitura direta do PostgreSQL nem estado paralelo calculado no
cliente.

## Policy eval T-FR-131

O dataset `tests/fixtures/proof-needs/integrity-policy-cases.json` contém
quatorze casos:

1. aprovação exata;
2. aprovação com diferenças superficiais normalizáveis;
3. drift de claim;
4. produto incompatível;
5. pessoa incompatível;
6. período incompatível;
7. audience incompleta;
8. consentimento expirado;
9. contexto ausente;
10. range de contexto incompleto;
11. adjacência ausente;
12. pessoa ausente na recipe;
13. prova indisponível;
14. prova desnecessária.

O teste mede falsos positivos e falsos negativos críticos, preservação de
presentation, issues acionáveis e round-trip/tamper canônico.

## Evidência automatizada

- policy eval e domínio: `tests/v2/proof-integrity.test.mjs`, 4/4;
- regressão dos módulos posteriores que antes continham placeholder:
  `tests/v2/source-proof-longform.test.mjs`, 5/5;
- schema/migrations: 102 tabelas, 515 índices e 394 FKs;
- contratos públicos: 157 capabilities, 244 schemas, 276 exemplos e 125 paths;
- API/PostgreSQL:
  `tests/v2/prisma-compatibility-graph.integration.mjs`;
- segurança de ferramentas, concorrência e precondições:
  `tests/v2/external-command-concurrency-coverage.test.mjs` e
  `tests/v2/external-mutation-precondition-coverage.test.mjs`;
- build de produção e TypeScript completos.

O E2E reconstrói uma database isolada do zero, compila H+B+proof+CTA, cria
ProofNeeds, aprova a evidência exata, bloqueia contexto incompleto, processa
`proof-unavailable` e `no-proof-needed`, testa autenticação, replay, mismatch,
read, filtros e capability discovery. Também prova que constraints rejeitam
fabricação e aprovação adulterada e que a contagem de media artifacts não muda.

## Reprodutibilidade do PostgreSQL

Durante o gate, uma reconstrução limpa revelou que
`infra/postgres/compose.yml` usava `postgres:16-alpine`, embora a migration de
busca semântica exigisse pgvector. A database histórica mascarava o problema
porque a extensão já havia sido instalada antes.

A imagem declarada foi corrigida para
`pgvector/pgvector:0.8.5-pg16-trixie`. Uma instância isolada usando essa imagem
aplicou todas as migrations, inclusive `vector`, antes de executar o E2E.

Esse ajuste não altera o formato major do PostgreSQL: continua em PostgreSQL
16. O deploy exige backup verificado antes de substituir o contêiner de banco.

## Evidência de produção

CI `32778637601` executou o E2E T-FR-131 pela API `/v1` e PostgreSQL
descartável, com as oito dimensões, tamper/stale, replay, zero artifacts e
postflight sem conexão órfã; `32780695560` repetiu o gate na reconciliação. A
imagem `apollo-video:596f388` foi implantada após backup validado, aplicou 170
migrations e ficou com health 200, web e quatro workers sem restart ou erro
crítico. F2.020 foi aceito em 2026-08-24.
