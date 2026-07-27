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

Implantação aprovada em 2026-07-27:

- commit, release e imagem: `f1459fb` / `apollo-video:f1459fb`;
- archive do commit verificado localmente e na VPS:
  SHA-256 `554ef00cc040b32b4dceced547900bb72af8bed1f510836a01e2a44001d4f2ea`;
- backup anterior à migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260727T143401Z.dump`;
- SHA-256 do backup:
  `84353c093843688179541e4935d2162b0c578f0ce7f8b9dadaa4218f3853387e`;
- `pg_restore --list` aprovou o backup;
- migration `20260727150000_long_form_moment_catalog` aplicada;
- 57 migrations reconhecidas e nenhuma pendente;
- aplicação, ingest worker, render worker e webhook worker executando
  `apollo-video:f1459fb`, saudáveis e com zero reinícios;
- build revision dentro do container: `f1459fb`;
- health, OpenAPI e capability discovery responderam HTTP 200;
- OpenAPI publicou `POST` e `GET`
  `/v1/projects/{projectId}/long-form-moments`;
- discovery autenticado publicou as capabilities de catálogo e busca.

Smoke autenticado no projeto
`project-fe932791-32f4-4453-8b85-6ce35a711860`:

- master real:
  `artifact-89a72429c007-3405acad6ec8718c6742f4db21bcdb818b4f41eb8140f0fc91f18dfe2e7f8ada`;
- índice:
  `long-form-index-run-f2007cef-4901-443e-be66-2238c6247533`;
- hash:
  `8ff7d94d94cdd23c7d32dd2d38bcb1e7944053282731b33e960eeeaaddbc30de`;
- criação HTTP 201;
- replay com a mesma idempotency key HTTP 200 e a mesma identidade;
- busca HTTP 200 encontrou `moment-positioning` por texto, speaker, papel,
  tag e salience;
- preview primário expandido para `47000–70000 ms`, com dois ranges;
- `eligibleForReuse=true`;
- chamada sem credencial retornou HTTP 401;
- índice sem resumo monolítico, com dois chapters e dois moments;
- PostgreSQL confirmou todos os quatro registros virtuais, zero inválidos e
  exatamente um índice ativo;
- artifacts físicos permaneceram em 7 antes e depois do catálogo.
