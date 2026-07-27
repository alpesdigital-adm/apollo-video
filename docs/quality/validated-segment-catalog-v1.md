# F2.004 — ValidatedSegment catalog v1

## 1. Resultado do slice

Este gate registra que um hook, um segmento ou um vídeo inteiro apresentou
determinado desempenho histórico em uma publicação observada. O registro
preserva fonte, escopo explícito, data, evidência quantitativa, comparação,
validade, direitos e o material exato ao qual a observação se refere.

O sistema não transforma correlação histórica em causalidade. Toda evidência
usa a interpretação `historical-association/v1`, e uma solicitação de alegação
causal é sempre incompatível.

`ValidatedSegment` é um range virtual: catalogá-lo não cria, copia ou recodifica
um arquivo de vídeo.

## 2. Escopo de validação

As unidades aceitas são:

- `hook`: somente o hook identificado pelo `SpeechSegment`;
- `segment`: somente o segmento identificado pelo `SpeechSegment`;
- `whole-video`: o master inteiro.

`wholeVideoValidated` nunca é informado pelo cliente. Ele é derivado
exclusivamente de `scope.unit=whole-video`.

Hook e segmento exigem:

- `sourceSpeechSegmentId`;
- hash exato do `SpeechSegment`;
- texto, speaker e range recuperados no servidor;
- artifact, manifest e hashes exatos;
- snapshot atual de direitos.

Vídeo inteiro proíbe a identificação de um único `SpeechSegment` e usa o range
`0..durationMs` medido pelo manifest.

## 3. Protected envelope

O envelope `protected-validation-envelope/v1` deriva os aspectos protegidos do
escopo da evidência:

| Evidence scope | Aspectos protegidos |
| --- | --- |
| `copy` | copy |
| `spoken-take` | copy, take |
| `opening-edit` | copy, take, timing, opening |

O envelope preserva artifact, SHA-256, range, `SpeechSegment`, hash, copy exata
e speaker quando aplicáveis. Seu hash canônico detecta alteração persistida.

O preflight recebe uma nova recipe e retorna uma decisão explícita. Mudanças em
aspectos protegidos, uso em papel incompatível, expiração, direitos alterados ou
alegação causal tornam o reuso incompatível, sem apagar a evidência histórica.

## 4. Evidência de performance

Cada registro contém:

- plataforma, referência da publicação, conta e URL HTTPS opcionais;
- instante observado;
- métrica, valor, unidade e tamanho da amostra;
- período positivo de observação;
- comparação opcional com label, valor e unidade;
- `validatedAt` e `expiresAt` opcional.

Valores de `ratio`, `percent` e `score`, inclusive comparações, possuem limites
semânticos. A cronologia exige observação e término do período anteriores à
validação, validação anterior à criação e expiração posterior à validação.

## 5. Contratos públicos

### Catalogar

- Capability: `apollo.projects.validated-segments.catalog`
- Método: `POST`
- Rota: `/v1/projects/{projectId}/validated-segments`
- Scope: `projects:write`
- Idempotência: obrigatória
- Policy: `validated-segment/v1`

### Pesquisar

- Capability: `apollo.projects.validated-segments.search`
- Método: `GET`
- Rota: `/v1/projects/{projectId}/validated-segments`
- Scope: `projects:read`

Filtros: texto, artifact, plataforma, unidade, evidence scope, métrica,
validade atual e limite.

### Avaliar reuso

- Capability: `apollo.projects.validated-segments.reuse-preflight`
- Método: `POST`
- Rota:
  `/v1/projects/{projectId}/validated-segments/{validatedSegmentId}/reuse-preflight`
- Scope: `projects:read`

Todas as três operações também estão publicadas por capability discovery,
OpenAPI, schemas versionados, exemplos públicos e ferramentas de agente.
Payloads e queries rejeitam campos desconhecidos, e `workspaceId` sempre vem da
credencial Bearer.

## 6. Persistência e integridade

`validated_segments` registra:

- workspace, projeto, artifact, manifest e `SpeechSegment` opcionais;
- hashes exatos das fontes;
- scope e `wholeVideoValidated` derivado;
- fonte e performance em JSON canônico;
- protected envelope e aspectos pesquisáveis;
- snapshot, status de direitos e consentimento;
- datas de validação e expiração;
- policy de claim, policy do catálogo e ator API;
- request fingerprint, idempotency key e hash do registro.

Constraints PostgreSQL impedem:

- hash que não seja SHA-256;
- unidade ou evidence scope desconhecidos;
- `wholeVideoValidated` divergente da unidade;
- hook/segmento sem `SpeechSegment`;
- vídeo inteiro associado a um único `SpeechSegment`;
- policy ou ator incompatível;
- `causalClaimAllowed=true`;
- `physicalMaterialized=true`;
- direitos, consentimento ou cronologia inválidos.

A persistência usa transação serializável, retry limitado e revalida artifact,
manifest, `SpeechSegment`, ator e snapshot de direitos no commit. Replays
idempotentes retornam a identidade original; reutilização da chave com payload
diferente retorna conflito.

## 7. Evidência automatizada local

- banco isolado `apollo_video_v2_e2e_speech`;
- 58 migrations aplicadas;
- validação estática: 58 tabelas, 284 indexes e 202 foreign keys;
- `T-FR-046`: 5/5 testes de domínio;
- regressão integral: 498/498;
- integração API/PostgreSQL: 1/1;
- build Next.js 16.2.12: aprovado;
- typecheck, arquitetura e linguagem de domínio: aprovados;
- contratos: 100 capabilities, 166 schemas, 194 examples e 82 paths;
- auditorias do app e do renderer: zero vulnerabilidades conhecidas.

O E2E comprova catálogo de hook e vídeo inteiro, busca, replay, payload
divergente, hash desatualizado, preflight compatível e incompatível, causalidade
bloqueada, expiração, rotação de direitos, concorrência, acesso sem credencial,
constraints SQL e ausência de novos artifacts físicos.

## 8. Evidência de produção

Implantação aprovada em 2026-07-27:

- commit, release e imagem: `a91f0a4` / `apollo-video:a91f0a4`;
- image ID:
  `sha256:78539aed163eaaf0d56c1ab6449bc292d48aef92e8f5f89d46085be002a45351`;
- archive do commit verificado localmente e na VPS:
  SHA-256 `b5e3cd1cdddd755500f5ccf2405a6da06e32737973f56b4ce74141335909d452`;
- backup anterior à migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260727T154538Z.dump`;
- SHA-256 do backup:
  `84b7e97dbd8a63f7cc40917b94961bcb07296f8a2a0483056dc7b49aecd44695`;
- `pg_restore --list`: aprovado;
- migration `20260727160000_validated_segment_catalog`: aplicada;
- 58 migrations reconhecidas e nenhuma pendente;
- aplicação e três workers executando a mesma imagem, com zero reinícios;
- aplicação saudável, revisão `a91f0a4` e Next.js 16.2.12;
- health, OpenAPI e capability discovery: HTTP 200;
- OpenAPI publicou catálogo, busca e reuse preflight.

Smoke autenticado no projeto
`project-fe932791-32f4-4453-8b85-6ce35a711860`:

- master:
  `artifact-89a72429c007-7ce34ba3acbb607eb1f47f419d73a8587a6f687bbfc0d9a1f115d7d9d771dccf`;
- `SpeechSegment`:
  `speech-segment-81438b35-d9c4-443b-9fea-8bc2c20a77a2`;
- `ValidatedSegment`:
  `validated-segment-b8487d2d-4242-42c2-9313-4b46e0c0128a`;
- hash:
  `b883379f5cfa7032144a0c263b40c88eae567ea127a336c08b34e3cad5b9ffda`;
- catálogo HTTP 201 e replay HTTP 200;
- busca HTTP 200 com `eligibleForReuse=true`;
- recipe de hook sem mudanças: compatível;
- recipe de body alterando copy/timing e alegando causalidade: bloqueada por
  `VALIDATION_UNIT_HOOK_ONLY`, `PROTECTED_COPY`, `PROTECTED_TIMING` e
  `CAUSALITY_NOT_SUPPORTED`;
- chamada sem credencial: HTTP 401;
- capability discovery autenticado encontrou as três capacidades;
- PostgreSQL confirmou `hook`, `opening-edit`,
  `wholeVideoValidated=false`, `causalClaimAllowed=false` e
  `physicalMaterialized=false`;
- zero registros inválidos;
- artifacts físicos permaneceram em 7.
