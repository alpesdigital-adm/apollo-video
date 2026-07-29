# F2.017 — limpeza MVP de fontes

## Resultado entregue

O Apollo V2 transforma um achado exato de `ContaminationReport` em uma decisão
de limpeza auditável. O plano escolhe uma entre quatro estratégias explícitas:

- `trim`, apenas quando o contaminante ocupa uma borda temporal removível;
- `crop-reframe`, quando um recorte de borda remove o elemento sem atingir
  regiões protegidas;
- `cover`, para uma pequena região visual interna que pode ser coberta dentro
  do limite da policy;
- `reject`, quando a remoção seria destrutiva, exigiria capacidade avançada,
  não preservaria integridade ou não estivesse autorizada pelos direitos.

A escolha compara qualidade residual, integridade e custo. O master permanece
imutável em todas as decisões. Uma estratégia executável cria um novo artifact
com manifest e lineage próprios; `reject` não cria mídia.

## Fluxo V2

`ContaminationReport imutável → POST /v1 → SourceCleanupPlan → PublicOperation
durável → worker com lease/fence → FFmpeg → derivative → manifest/lineage →
rights herdados → postCleanupReview → GET /v1 e UI`

Não existe rota `/api`, SQLite, dual-write, fallback ou código de
compatibilidade. O request vincula o hash exato do relatório, o finding, a
policy e o ator. Antes de criar o plano, o serviço revalida artifact, SHA-256,
manifest, projeto e rights atuais. A transação serializable grava plano e
operação juntos; replay exige o mesmo ator, idempotency key e fingerprint.

## Decisão canônica

`source-cleanup-plan/v1` registra:

- relatório e finding com seus hashes;
- artifact, SHA-256 e manifest de origem;
- todos os candidatos, elegibilidade, scores e reason codes;
- policy `source-cleanup-mvp/v1`;
- estratégia e ação escolhidas;
- qualidade residual, integridade e custo previstos;
- snapshot/decisão de rights;
- identidades determinísticas de operation, output artifact e manifest;
- obrigação de revisão pós-limpeza;
- `sourceImmutable=true` e hash canônico do plano.

O domínio reconstrói o plano na leitura e rejeita divergência entre JSON
canônico e projeções relacionais.

## Execução e revisão

O worker de render consulta somente operações `source-cleanup`, usa lease,
heartbeat e fencing e reabre o plano imutável antes de qualquer efeito. Ele:

1. revalida o artifact, manifest, SHA-256 e snapshot de rights;
2. calcula o SHA-256 do arquivo-fonte antes do FFmpeg;
3. executa trim, crop/reframe ou cover;
4. calcula novamente o SHA-256 do source e falha se um byte mudou;
5. promove o resultado no prefixo content-addressed `cleaned`;
6. persiste artifact, manifest V2, recipe, tool digest e lineage;
7. cria um snapshot de rights herdado para o derivative e o reavalia;
8. grava `post-cleanup-review/v1` com checks visuais e de direitos;
9. conclui a operação somente quando a revisão passa.

Falha de direitos, plano adulterado, source divergente, output inválido,
review reprovada ou perda do lease impedem publicação bem-sucedida.

## Persistência

A migration `20260728225000_source_cleanup_mvp`:

- amplia a constraint de `public_operations` com `source-cleanup`;
- cria `source_cleanup_plans`;
- cria `source_cleanup_results`;
- aplica FKs compostas de workspace/projeto para relatório, finding, source,
  manifest, creator, rights, operação e derivative;
- aplica checks de estratégia, decisão, scores, hashes, JSON e presença
  coerente de output;
- cria índices para idempotência, paginação, finding, source e operação.

O source nunca é atualizado pela limpeza. O resultado é uma nova linha em
`media_artifacts` e `media_artifact_manifests`, ligada ao source por lineage.

## API pública

| Capability | Método e caminho | Escopo |
| --- | --- | --- |
| `apollo.projects.source-cleanups.list` | `GET /v1/projects/{projectId}/source-cleanups` | `projects:read` |
| `apollo.projects.source-cleanups.create` | `POST /v1/projects/{projectId}/source-cleanups` | `projects:write` |
| `apollo.projects.source-cleanups.read` | `GET /v1/projects/{projectId}/source-cleanups/{cleanupPlanId}` | `projects:read` |

Os contratos possuem schemas versionados, exemplos, OpenAPI, classificação de
segurança para agente, auditoria de concorrência e estratégia explícita de
precondição. A criação retorna `202` quando enfileira um derivative, `201`
quando decide `reject` e `200` em replay idempotente.

## Interface

O painel “Integridade da fonte” do editor consome somente `/v1` e, para cada
finding:

- permite ao Diretor planejar a limpeza ou confirmar preservação;
- mostra trim, recorte/reenquadramento, cobertura ou rejeição;
- mostra qualidade e integridade previstas;
- acompanha a geração do derivative;
- distingue falha, preservação e revisão aprovada;
- mostra aprovação visual e de direitos;
- mantém explícito que o master permanece intacto.

A lateral do workspace reconhece `source-cleanup` como pipeline próprio, com
render, revisão pós-limpeza e persistência do derivative.

## Evidências

- domínio: `tests/v2/source-cleanup.test.mjs`;
- goldens FFmpeg reais: `tests/v2/ffmpeg-source-cleanup.integration.mjs`;
- worker com lease, source imutável, lineage, rights e review:
  `tests/v2/source-cleanup-worker.test.mjs`;
- API, PostgreSQL, worker e FFmpeg integrados:
  `tests/v2/prisma-contamination-report.integration.mjs`;
- interface API-backed: `tests/v2/project-editor-ui.test.mjs`;
- 21/21 testes direcionados aprovados;
- 572/572 testes de regressão aprovados;
- E2E isolado API → PostgreSQL → worker → FFmpeg → API: 1/1;
- source SHA-256 idêntico antes/depois e exatamente um derivative criado;
- contratos: 147 capabilities, 231 schemas, 263 exemplos e 118 paths;
- migration verifier: 96 tabelas, 471 índices e 364 FKs;
- lint de arquitetura, linguagem canônica, TypeScript e build Next aprovados.

## Limites deliberados

- O MVP não faz separação de stems, inpainting generativo ou restauração
  semântica; esses recursos pertencem à limpeza avançada.
- Música mixada e remoção destrutiva resultam em `reject`.
- `cover` é limitado a pequenas regiões e nunca sobrepõe conteúdo protegido.
- O derivative limpo fica disponível ao catálogo e ao Diretor por API; a
  seleção automática entre múltiplas fontes continua nos gates seguintes.
