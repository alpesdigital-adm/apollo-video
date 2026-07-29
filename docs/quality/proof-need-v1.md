# F2.019 — Proof need v1

## Resultado entregue

O Apollo V2 agora transforma uma afirmação existente no `StoryPlan` de um
`VariantRecipe` em uma necessidade de prova explícita e auditável. Cada
declaração registra:

- a afirmação e o bloco narrativo exatos;
- o tipo de prova necessário;
- a função editorial que a prova deve cumprir;
- o momento exato de entrada na narrativa e na timeline;
- as categorias pesquisadas no catálogo de `EvidenceSegments`;
- os candidatos encontrados e rejeitados;
- a evidência selecionada, `proof-unavailable` ou `no-proof-needed`.

O resultado é um `ProofDirectedStoryPlan` imutável. Ele conserva atos e blocos
do StoryPlan de origem e acrescenta as declarações de prova sem alterar o
master, materializar mídia, iniciar provider ou criar render.

## Política editorial

A política `proof-need-policy/v1` é derivada no servidor:

| Claim | Tipo | Função | Busca |
| --- | --- | --- | --- |
| `outcome` | `testimonial` | `build-trust` | `testimonial`, `case-study` |
| `quantified` | `data` | `substantiate-quantified-claim` | `financial-result`, `before-after`, `authority`, `case-study` |
| `mechanism` | `demonstration` | `demonstrate-mechanism` | `demonstration` |
| `low-risk` | `none` | `no-proof-needed` | não executada |

O cliente externo declara a classificação do claim, mas não controla o tipo,
a função, as categorias ou a resolução resultante. Uma declaração precisa
referenciar um `claimId` realmente presente no `storyBlockId` da recipe exata.

## Momento narrativo e temporal

O momento é compilado do StoryPlan e do EditPlan da mesma recipe:

- quando existe um bloco de prova posterior ao claim, a entrada usa o primeiro
  frame desse bloco e `placement=existing-proof-block`;
- sem bloco de prova, a entrada fica no fim do clip que contém o claim e antes
  do bloco seguinte;
- claims de baixo risco recebem `placement=not-applicable`.

Frame e milissegundo são persistidos juntos. A hidratação rejeita divergência
entre declaração, StoryPlan direcionado, item e projeções relacionais.

## Evidence-first e ausência honesta

Para toda prova obrigatória, o serviço consulta primeiro o repositório real de
`EvidenceSegments`, categoria por categoria. A busca:

1. opera dentro do workspace e projeto da credencial;
2. compara o claim pretendido sem drift;
3. inclui o contexto obrigatório;
4. aplica compatibilidade de oferta e objeção quando informadas;
5. avalia integridade, rights, consent e expiração;
6. classifica somente candidatos autorizados do tipo compatível.

O ranking usa credibilidade, especificidade e autenticidade. O plano conserva
os IDs consultados e as razões de rejeição.

Quando nenhum candidato compatível e autorizado existe, a resolução é
`proof-unavailable`. O sistema não converte a ausência em texto ilustrativo,
estatística inventada ou card genérico. Para claims de baixo risco, a resolução
é `no-proof-needed`, também sem card.

As invariantes `genericCardGenerated=false` em cada item e
`genericCardCount=0` no agregado existem no domínio, no JSON canônico, nas
projeções e em constraints PostgreSQL.

## Persistência, concorrência e direitos

A migration `20260729030000_proof_need_runs` cria:

- `proof_need_runs`, com recipe, StoryPlan base, StoryPlan direcionado, hashes,
  resumo, ator e idempotência;
- `proof_need_items`, com claim, classificação, função, momento, auditoria da
  busca, resolução e evidência selecionada;
- FKs compostas para workspace, projeto, batch, `VariantRecipe`, API client e
  `EvidenceSegment`;
- constraints de versão, contagem, coerência entre tipo/função/obrigatoriedade,
  resolução, seleção e proibição de card fabricado.

A criação usa transação serializável. Antes do commit, revalida:

- ID, hash, projeto, batch e StoryPlan da recipe;
- existência e estado ativo do ator;
- ID, hash, categoria, artifact e ranges da evidência selecionada;
- equivalência entre claim declarado e claim catalogado;
- integridade atual;
- snapshot atual de rights, status, consent e expiração.

Replay com o mesmo ator, chave e payload converge. A mesma chave com payload
diferente falha. Conflitos serializáveis são tentados novamente de forma
limitada.

## API pública

| Capability | Método e rota | Escopo |
| --- | --- | --- |
| `apollo.projects.proof-needs.list` | `GET /v1/projects/{projectId}/proof-needs` | `projects:read` |
| `apollo.projects.proof-needs.create` | `POST /v1/projects/{projectId}/proof-needs` | `projects:write` |
| `apollo.projects.proof-needs.read` | `GET /v1/projects/{projectId}/proof-needs/{runId}` | `projects:read` |

As três operações estão em capability discovery, OpenAPI, schemas versionados,
exemplos e ferramentas de agente. A mutação é classificada como bounded, exige
idempotência, aceita no máximo dezesseis declarações e inicia zero trabalho
externo.

## Interface

O painel “Direção de prova” do editor consome somente a API `/v1`. Para cada
claim, mostra:

- tipo de prova;
- resolução;
- texto da afirmação;
- posição narrativa e timecode;
- busca evidence-first e quantidade de candidatos;
- segmento selecionado, contexto e score;
- ausência explícita ou dispensa pela policy;
- confirmação permanente de que card genérico não foi gerado.

Não existe leitura direta do banco nem estado paralelo fabricado pela UI.

## Evidência automatizada

- golden stories:
  `tests/fixtures/proof-needs/stories.json`;
- domínio e round-trip canônico:
  `tests/v2/proof-need.test.mjs`, 5/5;
- interface API-backed:
  `tests/v2/project-editor-ui.test.mjs`;
- concorrência, precondições e segurança de ferramentas:
  `tests/v2/external-command-concurrency-coverage.test.mjs`,
  `tests/v2/external-mutation-precondition-coverage.test.mjs` e contratos;
- API/PostgreSQL:
  `tests/v2/prisma-compatibility-graph.integration.mjs`;
- banco isolado `apollo_video_v2_e2e_f2019`, 74 migrations;
- verificação estática: 100 tabelas, 499 índices e 383 chaves estrangeiras;
- contratos: 154 capabilities, 240 schemas, 272 examples e 123 paths;
- regressão integral: 581/581;
- build, typecheck, arquitetura API-first/V2-only, linguagem canônica e audits
  de dependências aprovados.

O E2E cataloga uma evidência de depoimento com rights e consent aprovados,
compila H+B+proof+CTA, seleciona o segmento real no momento exato do StoryPlan,
testa `proof-unavailable`, `no-proof-needed`, replay, mismatch, leitura, filtro
e capability discovery. Confirma zero artifact adicional e prova que o
PostgreSQL rejeita card fabricado, resolução incoerente e contagem genérica
maior que zero.

## Evidência de produção

O release funcional `253fcc0` foi implantado em
`https://apollo.alpesd.com.br` e auditado após a substituição dos serviços:

- imagem `apollo-video:253fcc0`, ID
  `sha256:3f2c12cd95ed1b6834c569ecb873fd475315ab2f6dab1218cf5837cc0f548d93`;
- arquivo de release com SHA-256
  `6cd2b8312ee12a81ac8af0452b6a9e65ec401deae4590e240d7d2a75694d94f0`;
- backup anterior ao deploy
  `/opt/backups/apollo-video/apollo_video_v2-20260729T113252Z.dump`, SHA-256
  `dcaf32b394019602daa2606c0f912d8d59d38b3e984e5d4ba662df0d99718485`,
  validado por `pg_restore --list`;
- 74 migrations aplicadas e zero migration incompleta;
- aplicação, ingest worker, render worker e webhook worker executando a imagem
  exata, com zero reinício; aplicação reportando estado saudável;
- `/v1/health`, `/v1/openapi.json` e listagem autenticada de Proof Need
  retornando HTTP 200;
- OpenAPI público expondo exatamente os dois paths e as três capabilities de
  Proof Need;
- logs dos quatro serviços sem erro crítico após o deploy.
