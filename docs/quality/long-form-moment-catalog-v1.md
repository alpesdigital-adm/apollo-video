# F2.003 — LongFormMoment catalog v1

## 1. Resultado do slice

Este gate transforma a análise de um vídeo longo em um índice editorial
hierárquico, imutável e pesquisável. A fonte continua sendo um único master:
chapters e moments são ranges virtuais e nunca criam um arquivo físico por
trecho.

O modelo não exige nem armazena um resumo monolítico do vídeo. Cada chapter
possui título, topic path e range; cada moment pertence a um chapter e preserva
assunto, resumo, citação, speakers, um ou mais ranges, evidências, papéis, tags
e scores editoriais.

## 2. Contratos públicos

### Catalogar

- Capability: `apollo.projects.long-form-moments.catalog`
- Método: `POST`
- Rota: `/v1/projects/{projectId}/long-form-moments`
- Scope: `projects:write`
- Idempotência: obrigatória
- Precondições: SHA-256 exato do artifact e hash exato do manifest
- Policy: `long-form-index/v1`

O request identifica o produtor da análise por provider, model, version e
confidence. Chapters e moments recebem provenance por observação; workspace,
projeto, artifact, manifest, duração, direitos, consentimento e ator são
resolvidos ou revalidados no servidor.

### Pesquisar e abrir contexto

- Capability: `apollo.projects.long-form-moments.search`
- Método: `GET`
- Rota: `/v1/projects/{projectId}/long-form-moments`
- Scope: `projects:read`

Filtros disponíveis:

- texto em assunto, resumo, citação, papel ou tag;
- chapter;
- artifact de origem;
- speaker;
- papel e tag exatos;
- salience mínima.

Cada resultado declara `matchedBy`, chapter e moment completos, estado atual de
direitos e uma prévia virtual. `contextBeforeMs` e `contextAfterMs` expandem
cada range de forma independente, limitados a 300 segundos e às bordas do
master. O range recomendado define a prévia primária.

## 3. Modelo persistente

`long_form_index_runs` registra:

- workspace, projeto, artifact e manifest exatos;
- SHA-256 do artifact e hash do manifest;
- duração do master;
- snapshot, status de direitos e consentimento usados;
- policy e produtor da análise;
- contagens de chapters e moments;
- hash da hierarquia, request fingerprint, idempotency key e hash do registro;
- ator API, criação e estado ativo.

`long_form_chapters` registra:

- identidade no analisador e identidade canônica;
- ordem, título observado, topic path e range no master;
- policy, provenance indireta pelo título, hash e
  `physicalMaterialized=false`.

`long_form_moments` registra:

- chapter e artifact de origem;
- ordem e identidade no analisador;
- assunto, resumo e citação com provenance;
- speakers e evidências relacionadas;
- todos os ranges e o range recomendado;
- salience, hook potential, standalone, context e insight density;
- papéis, tags, texto normalizado, policy, hash e
  `physicalMaterialized=false`.

Constraints PostgreSQL impedem:

- materialização física de chapters e moments;
- ranges recomendados vazios ou invertidos;
- scores fora de `0..1`;
- policy, ator ou status de direitos desconhecidos;
- hashes que não sejam SHA-256;
- ordens e identidades duplicadas no mesmo índice;
- mais de um índice ativo para o mesmo artifact no projeto;
- reuso de idempotency key no mesmo projeto.

## 4. Integridade, concorrência e direitos

- a fonte precisa ser um vídeo disponível e vinculado ao projeto;
- manifest, SHA-256, duração e snapshot de direitos são conferidos na leitura e
  novamente no commit;
- chapters precisam ser cronológicos e não sobrepostos;
- ranges dos moments precisam ser cronológicos, não sobrepostos e contidos no
  chapter e no master;
- persistência usa transação serializável e retry limitado;
- um novo índice desativa o anterior, mas preserva o histórico virtual;
- busca usa somente o índice ativo;
- mudança, revogação ou expiração de direitos bloqueia reutilização sem apagar
  o índice histórico;
- papel e tag usam correspondência de item completo, sem falso positivo por
  substring;
- fingerprint, idempotency key e identidade de storage não são expostos.

## 5. Superfície externa

As operações estão disponíveis na API HTTP, capability discovery, OpenAPI,
schemas públicos e ferramentas de agente. A mutação possui classificação
explícita de concorrência, precondição e safety gate. O `workspaceId` sempre
vem da credencial Bearer; payload e query rejeitam campos desconhecidos.

## 6. Evidência automatizada local

Banco isolado:

- `apollo_video_v2_e2e_speech`;
- 57 migrations aplicadas;
- validação estática: 57 tabelas, 273 indexes e 195 foreign keys.

Resultados do slice:

- `T-FR-045`: 4/4 testes de domínio e aplicação;
- regressão integral: 493/493;
- integração API/PostgreSQL `T-FR-045`: 1/1;
- build Next.js: aprovado;
- typecheck, arquitetura e linguagem de domínio: aprovados;
- contratos públicos: 97 capabilities, 161 schemas, 188 examples e 80 paths.

O E2E usa um manifest de duas horas, dois chapters e dois assuntos e comprova:

- criação HTTP 201 e replay HTTP 200 com a mesma identidade;
- conflito HTTP 409 para payload diferente na mesma idempotency key;
- conflito HTTP 409 para SHA-256 desatualizado;
- ausência de resumo monolítico no índice;
- hierarquia e provenance com hashes íntegros;
- busca por texto, speaker, papel, tag e salience;
- correspondência exata de papel sem falso positivo por substring;
- prévia independente dos dois ranges, com contexto anterior e posterior;
- nenhuma criação de artifact físico;
- rejeição PostgreSQL de `physicalMaterialized=true`;
- bloqueio `RIGHTS_SNAPSHOT_STALE` após nova revisão de direitos;
- duas reindexações concorrentes preservando três hierarquias imutáveis, uma
  única ativa e zero novos artifacts;
- acesso sem credencial retorna HTTP 401.

## 7. Evidência de produção

Esta seção será preenchida somente após backup, migration, deploy do commit
exato e smoke autenticado em produção. O gate permanece aberto no `TODO.md`
até essa evidência existir.
