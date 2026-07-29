# F2.018 — Validation envelope v1

## Resultado entregue

O Apollo V2 agora compõe um hook historicamente validado com corpo, prova
opcional e CTA de um `VariantRecipe` novo sem tratar o desempenho passado como
causalidade e sem copiar material excedente. O plano é virtual e referencia
ranges exatos dos masters imutáveis; não cria arquivo, render ou job.

O envelope representa separadamente cinco aspectos editoriais:

| Aspecto | O que protege |
| --- | --- |
| `copy` | texto exato da fala validada |
| `take` | interpretação, speaker e tomada observada |
| `framing` | enquadramento presente na abertura observada |
| `timing` | range e ritmo temporal observados |
| `opening` | posição e montagem do hook como abertura |

A policy `validation-envelope-policy/v1` deriva a proteção da evidência:

- `copy`: protege apenas `copy`;
- `spoken-take`: protege `copy` e `take`;
- `opening-edit`: protege os cinco aspectos.

O cliente não pode declarar quais partes estão protegidas. Isso é derivado no
servidor do `ValidatedSegment` persistido.

## Composição sem material excedente

O plano `validation-envelope-composition/v1` é construído nesta ordem:

1. range exato do hook no `protectedEnvelope` do `ValidatedSegment`;
2. range primário de `body` no `VariantRecipe` alvo;
3. range primário de `proof`, quando existir;
4. range primário de `cta`.

O hook e o cold open do `VariantRecipe` alvo são explicitamente excluídos.
Qualquer outro segmento da recipe também fica fora. As invariantes
`targetRecipeHookExcluded=true`,
`validatedSourceOutsideEnvelopeIncluded=false` e
`excessMaterialIncluded=false` são persistidas, reidratadas e protegidas por
constraints PostgreSQL.

Cada clip conserva artifact, hash, range, segmento e take aplicáveis. O plano,
a composição e cada decisão possuem SHA-256 canônico.

## Proteção e aprovação

Uma mudança pedida em aspecto mutável é aplicada ao plano. Em aspecto protegido:

- se opcional, é bloqueada automaticamente e a validação permanece
  `preserved`;
- se obrigatória para a composição, o plano fica `pending-approval`;
- se a saída do envelope for aprovada explicitamente, a validação fica `lost`
  e os aspectos perdidos são registrados;
- se for rejeitada, as mudanças ficam bloqueadas e a validação permanece
  `preserved`.

A aprovação não é um booleano enviado junto da criação. É uma segunda operação
autenticada, com escopo `projects:approve`, precondição pelo hash exato do plano,
idempotência própria e gate humano quando acionada como ferramenta de agente.

## Decisions log

`validation_envelope_decisions` é um log ordenado por plano:

- sequência 1, `created`: `ready` ou `approval-required`;
- sequência 2, `approval`: `approved` ou `rejected`.

As combinações entre outcome e estado da validação são fechadas por constraint.
O estado atual é sempre derivado da última decisão reidratada, nunca de um
campo mutável independente. A API retorna o histórico completo em leitura.

## API pública

| Capability | Método e rota | Escopo |
| --- | --- | --- |
| `apollo.projects.validation-envelope-reuses.list` | `GET /v1/projects/{projectId}/validation-envelope-reuses` | `projects:read` |
| `apollo.projects.validation-envelope-reuses.create` | `POST /v1/projects/{projectId}/validation-envelope-reuses` | `projects:write` |
| `apollo.projects.validation-envelope-reuses.read` | `GET /v1/projects/{projectId}/validation-envelope-reuses/{reusePlanId}` | `projects:read` |
| `apollo.projects.validation-envelope-reuses.approve` | `POST /v1/projects/{projectId}/validation-envelope-reuses/{reusePlanId}/approval` | `projects:approve` |

As quatro operações estão publicadas em capability discovery, OpenAPI, schemas
versionados, exemplos e ferramentas de agente. Requests rejeitam campos
desconhecidos; workspace e ator vêm exclusivamente da credencial Bearer.

## Persistência e concorrência

A migration `20260728233000_validation_envelope_reuse` cria:

- `validation_envelope_reuses`, com plano imutável, hashes das fontes,
  projeções pesquisáveis e idempotência por ator;
- `validation_envelope_decisions`, com sequência, outcome, estado e hash
  canônico;
- FKs compostas para workspace, projeto, batch, `ValidatedSegment`,
  `VariantRecipe` e API client;
- constraints para versões, ranges, hashes, estados, ausência de excesso e
  coerência entre outcome e validação.

A criação usa transação serializável e revalida no commit as fontes e o ator.
Hashes otimistas impedem compor contra `ValidatedSegment` ou `VariantRecipe`
desatualizado. Replay com o mesmo payload converge; a mesma chave com payload
diferente falha.

## Interface

O editor do projeto consome somente as rotas `/v1`. O painel “Envelope de
validação” usa uma faixa de cinco aspectos para distinguir protegido e
ajustável, mostra o material incluído/excluído e deixa explícito quando:

- a validação foi preservada;
- existe uma decisão humana pendente;
- a aprovação causará perda histórica;
- a validação já foi perdida e em quais aspectos.

O operador pode preservar o envelope ou aprovar conscientemente a saída. Não
existe mutação local paralela nem acesso direto ao banco pela interface.

## Evidência automatizada

- domínio: `tests/v2/validation-envelope.test.mjs`, 4/4;
- interface e uso exclusivo da API: `tests/v2/project-editor-ui.test.mjs`;
- contratos e segurança de ferramentas:
  `tests/v2/public-contracts.test.mjs`;
- API/PostgreSQL:
  `tests/v2/prisma-compatibility-graph.integration.mjs`;
- banco isolado `apollo_video_v2_e2e_f2018`, 73 migrations;
- verificação estática: 98 tabelas, 485 índices e 374 chaves estrangeiras;
- regressão integral: 576/576;
- contratos: 151 capabilities, 236 schemas, 268 examples e 121 paths;
- build de produção e typecheck aprovados.

O E2E cataloga um hook `opening-edit`, compõe-o com uma recipe H+B+proof+CTA,
confirma H+B+proof+CTA no resultado, exclui o hook e o cold open da recipe,
confirma zero material fora do envelope, testa replay, abre aprovação, aprova a
perda de `opening`, lê e lista o log, descobre as quatro capabilities e prova
que nenhum artifact físico foi criado. Tentativas SQL de incluir excesso,
combinar outcome/validação inválidos ou criar sequência de decisão inválida
são rejeitadas.
