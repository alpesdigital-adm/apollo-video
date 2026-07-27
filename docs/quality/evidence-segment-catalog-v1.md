# F2.002 — EvidenceSegment catalog v1

## 1. Resultado do slice

Este gate transforma um `SpeechSegment` ativo em uma evidência editorial
imutável e reutilizável. O registro preserva a alegação, resultado observado,
qualificadores, contexto, sujeito, atribuição, speaker, consentimento, direitos,
frames e ranges exatos da origem.

O catálogo não recorta nem duplica mídia. `EvidenceSegment` é um range virtual
do master e sempre persiste `physicalMaterialized=false`.

## 2. Contratos públicos

### Catalogar

- Capability: `apollo.projects.evidence-segments.catalog`
- Método: `POST`
- Rota: `/v1/projects/{projectId}/evidence-segments`
- Scope: `projects:write`
- Idempotência: obrigatória
- Precondição: `sourceSpeechSegmentId` +
  `expectedSpeechSegmentHash`
- Policy: `evidence-integrity/v1`

O cliente informa observações editoriais com `value` e `confidence`, mas não
controla transcript, speaker, artifact, hashes, range da fala, direitos,
consentimento ou identidade do ator. Esses campos são derivados novamente da
fonte persistida.

### Pesquisar e autorizar reutilização

- Capability: `apollo.projects.evidence-segments.search`
- Método: `GET`
- Rota: `/v1/projects/{projectId}/evidence-segments`
- Scope: `projects:read`

Filtros disponíveis:

- texto em claim, resultado, contexto ou qualifier;
- categoria;
- sujeito e atribuição;
- `SpeechSegment` de origem;
- oferta;
- objeção.

A resposta contém `matchedBy` e uma `reuseDecision` determinística. A decisão
exige a alegação pretendida, verifica contexto, qualifiers, oferta, objeção,
snapshot de direitos e consentimento atuais. Ela também devolve os ranges,
evidências adjacentes e qualifiers que precisam acompanhar o uso.

## 3. Modelo persistente

`evidence_segments` registra:

- workspace e projeto;
- `SpeechSegment`, transcript e artifact de origem;
- hashes exatos da fala e do transcript;
- snapshot, status de direitos e consentimento usados na catalogação;
- categoria, speaker, claim, resultado, contexto, qualifiers, sujeito e
  atribuição;
- compatibilidade com ofertas, audiências e objeções;
- scores de credibilidade, especificidade e autenticidade;
- range exato da fala, janela obrigatória de contexto e handles;
- referências de frames e evidências adjacentes;
- estado e razões de integridade;
- produtor/modelo/versão/confiança;
- ator API, idempotency key, request fingerprint e hash canônico;
- `physicalMaterialized=false`.

As constraints PostgreSQL impedem:

- materialização física de um segmento virtual;
- ranges vazios, invertidos ou contexto que não contenha a fala;
- handles incompatíveis com os ranges;
- scores fora de `0..1`;
- categoria, policy, status de integridade ou ator desconhecidos;
- hashes que não sejam SHA-256;
- duplicação da mesma idempotency key no projeto.

## 4. Política de integridade

Categorias suportadas:

- `testimonial`;
- `financial-result`;
- `before-after`;
- `hearsay`;
- `authority`;
- `case-study`;
- `demonstration`.

Regras fail-closed:

- direitos não aprovados bloqueiam qualquer evidência;
- consentimento precisa estar aprovado, exceto demonstração marcada como
  `not-required`;
- hearsay é bloqueado;
- resultado financeiro e antes/depois exigem qualifier;
- qualifiers e as categorias sensíveis obrigam o contexto;
- ausência de `intendedClaim` bloqueia uso;
- alteração semântica da alegação produz `CLAIM_DRIFT`;
- oferta ou objeção incompatível bloqueia uso;
- troca, revogação ou expiração dos direitos invalida o uso sem alterar o
  registro histórico.

## 5. Concorrência, isolamento e exposição

- autenticação Bearer e scopes são obrigatórios;
- o `workspaceId` vem exclusivamente do ator autenticado;
- leitura e escrita são limitadas ao projeto do workspace;
- payload e query aceitam somente campos conhecidos;
- listas, textos, IDs, ranges e scores possuem limites;
- fonte ativa, hashes, artifact, direitos e API client são revalidados no
  commit;
- persistência usa transação serializável e retry limitado;
- reuso da idempotency key com outro payload retorna conflito;
- fingerprints, idempotency keys e storage identities não são expostos;
- as duas operações estão no catálogo público, OpenAPI, schemas, exemplos,
  classificação de concorrência e safety gates do agente.

## 6. Evidência automatizada local

Banco isolado:

- `apollo_video_v2_e2e_speech`;
- 56 migrations aplicadas;
- validação estática: 54 tabelas, 251 indexes e 180 foreign keys.

Resultados:

- `T-FR-044`: 4/4 policy tests;
- regressão integral: 489/489;
- integração API/PostgreSQL conjunta `T-FR-043/T-FR-044`: 1/1;
- build Next.js: aprovado;
- typecheck: aprovado;
- schema/migrations: aprovados;
- contratos públicos: 95 capabilities, 158 schemas, 185 examples e 79 paths.

O E2E comprova:

- criação HTTP 201 e replay HTTP 200 com a mesma identidade;
- conflito HTTP 409 para a mesma chave com payload diferente;
- transcript, hash, ranges, frames, handles, consentimento e contexto exatos;
- bloqueio `CONTEXT_REQUIRED` sem contexto;
- autorização quando claim, contexto, oferta e objeção correspondem;
- nenhuma criação de artifact físico;
- rejeição PostgreSQL de `physicalMaterialized=true`;
- invalidação `RIGHTS_SNAPSHOT_STALE` após uma nova revisão de direitos;
- acesso sem credencial retorna HTTP 401.

## 7. Evidência de produção

Implantação aprovada em 2026-07-27:

- commit, release e imagem: `674948b` / `apollo-video:674948b`;
- archive do commit verificado antes do build:
  SHA-256 `35459f7b2d47d65d0bce331a986593d681a358bbf10c77c92c89c120964784f2`;
- backup anterior à migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260727T131212Z.dump`;
- SHA-256 do backup:
  `5635d096b1e529e89f6c4c30d4e4f0255a61d8811a891078e6609e3cc5071b93`;
- `pg_restore --list` aprovou o backup;
- migration `20260727140000_evidence_segment_catalog` aplicada;
- 56 migrations reconhecidas e nenhuma pendente;
- aplicação, ingest worker, render worker e webhook worker executando
  `apollo-video:674948b`, saudáveis e com zero reinícios;
- build revision dentro do container: `674948b`;
- health, OpenAPI e capability discovery responderam HTTP 200;
- OpenAPI publicou `POST` e `GET`
  `/v1/projects/{projectId}/evidence-segments`;
- discovery autenticado publicou as capabilities de catálogo e busca.

Smoke autenticado no projeto
`project-fe932791-32f4-4453-8b85-6ce35a711860`:

- fonte real:
  `speech-segment-81438b35-d9c4-443b-9fea-8bc2c20a77a2`;
- evidência:
  `evidence-segment-69a6bb40-0ee7-4864-ba24-c100d3e5689a`;
- hash:
  `e93b131627c2543c2ded2299e87be872e0d994dfe258b89955de0c2ed65ea062`;
- criação HTTP 201;
- replay com a mesma idempotency key HTTP 200 e a mesma identidade;
- busca/preflight HTTP 200, `allowed=true`;
- chamada sem credencial HTTP 401;
- transcript e hash da fonte permaneceram exatos;
- `integrityStatus=valid` e `physicalMaterialized=false`;
- fingerprints e idempotency keys internos não foram expostos;
- PostgreSQL confirmou duas evidências de diagnóstico, ambas virtuais, zero
  registros inválidos e o smoke pelo ID/hash exatos;
- artifacts físicos permaneceram em 7 antes e depois do catálogo.
