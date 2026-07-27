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

A implantação e o smoke autenticado serão registrados nesta seção somente após
backup, migration, substituição saudável dos containers e verificação direta
da API e do PostgreSQL.
