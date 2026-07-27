# F2.001 — SpeechSegment catalog v1

## 1. Resultado entregue pelo slice

Este gate transforma um `V2MediaTranscript` alinhado em um catálogo
persistente de segmentos virtuais. Cada segmento aponta para um range do
master existente e carrega texto, alinhamento, pessoa, classificação de
completude e observações semânticas/visuais.

O gate não recorta, copia nem gera mídia. Não existe `artifactKey`,
`manifestId`, `byteSize` ou artifact de saída no contrato de
`V2SpeechSegment`.

## 2. Contratos públicos

### Catalogar

- Capability: `apollo.projects.speech-segments.catalog`
- Método: `POST`
- Rota: `/v1/projects/{projectId}/speech-segments`
- Scope: `projects:write`
- Idempotência: obrigatória
- Precondição no payload: `sourceTranscriptId` +
  `expectedTranscriptHash`
- Policy aceita: `speech-segment-extraction/v1`

O comando persiste uma execução imutável, seus segmentos e o fingerprint
completo da requisição numa transação serializável.

### Pesquisar

- Capability: `apollo.projects.speech-segments.search`
- Método: `GET`
- Rota: `/v1/projects/{projectId}/speech-segments`
- Scope: `projects:read`

Filtros entregues:

- fala normalizada;
- intenção;
- pessoa/speaker;
- emoção;
- expressão;
- roupa;
- cenário;
- artifact de origem;
- classe de completude;
- score mínimo de pensamento completo.

Cada resultado informa `matchedBy`, estado dos direitos,
`eligibleForReuse` e `blockedReasons`.

## 3. Modelo persistente

### `speech_segment_catalog_runs`

Registra:

- workspace, projeto, transcript e artifact de origem;
- hash exato do transcript;
- versão da policy;
- produtor/modelo/versão/confiança;
- annotations e seus hashes;
- contagem de segmentos;
- ator API;
- idempotency key, request fingerprint e record hash;
- projeção `active`.

Uma nova execução não altera segmentos antigos. A transação desativa a
projeção anterior e ativa exatamente uma execução por transcript.

### `speech_segments`

Registra:

- `exactText` e `normalizedText`;
- alinhamento de todas as palavras em milissegundos;
- speaker e sua proveniência;
- range no master;
- `completeThoughtScore`;
- classe `complete-thought`, `incomplete` ou `interrupted`;
- emoção, expressão, roupa, cenário, cores e intenções;
- confiança e proveniência por observação;
- proveniência da extração;
- hash canônico do segmento;
- `physicalMaterialized=false`.

O banco possui constraints para:

- impedir `physicalMaterialized=true`;
- impedir range vazio/invertido;
- limitar score a `0..1`;
- limitar classificações e policy;
- exigir hashes SHA-256;
- manter uma única execução ativa por transcript.

## 4. Política determinística de extração

Cada segmento do transcript precisa possuir palavras alinhadas no próprio
range. O texto normalizado do segmento deve corresponder ao texto
normalizado das palavras alinhadas. Divergência falha antes da
persistência.

A classificação v1 considera:

- pontuação terminal e quantidade de palavras;
- conectivos/terminações que indicam dependência;
- reticências, travessão e marcações de interrupção;
- confiança do transcript.

Isso não transforma o score em verdade editorial. Ele permanece uma
evidência versionada para retrieval e decisão posterior do Diretor.

## 5. Segurança e concorrência

- autenticação Bearer obrigatória;
- isolamento por `workspaceId` obtido do ator autenticado;
- leitura e escrita limitadas ao projeto do workspace;
- request body fechado a campos conhecidos;
- arrays e observações possuem limites;
- transcript hash é revalidado na leitura e no commit;
- artifact precisa continuar disponível no commit;
- API client precisa continuar ativo no commit;
- idempotency key com payload diferente retorna conflito;
- duas recatalogações concorrentes convergem para uma única execução ativa;
- todas as execuções e segmentos históricos permanecem imutáveis.

## 6. Evidência automatizada local

Database isolada:

- `apollo_video_v2_e2e_speech`;
- bootstrap limpo com 55 migrations;
- 53 tabelas, 241 indexes e 173 foreign keys após validação estática.

Testes:

- `T-FR-043` cobre frase completa, corte incompleto, interrupção e múltiplos
  speakers;
- valida texto exato, normalização, words/ranges e hashes;
- valida confidence/provenance em speaker, visual e intenção;
- rejeita annotation desconhecida, ausência de words e texto divergente do
  alinhamento;
- executa API real contra PostgreSQL;
- valida autenticação, idempotência e conflito de transcript hash;
- pesquisa combinando fala, intenção, pessoa e características visuais;
- comprova que a quantidade de artifacts físicos não muda;
- força `physicalMaterialized=true` e comprova rejeição pelo banco;
- executa duas recatalogações concorrentes e comprova um único run ativo.

Resultados antes do deploy:

- unit/regressão: 485/485;
- integração PostgreSQL/API: 1/1;
- build Next.js: aprovado;
- typecheck: aprovado;
- arquitetura V2-only: aprovada;
- contratos públicos: 93 capabilities, 155 schemas, 182 examples e 78 paths;
- migration bootstrap limpo: aprovado.

## 7. Evidência de produção

Implantação aprovada em 2026-07-27:

- implementação base: commit `3fd3e55`;
- correção validada contra timestamps sobrepostos do transcript real:
  commit/imagem `fbbd4c5`;
- backup anterior à migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260727T121702Z.dump`,
  SHA-256
  `d2df3ea3dd380311f73bf8231945f38d567859bc5d57baddf0e2eaadbc111cd9`;
- migration `20260727123000_speech_segment_catalog` aplicada; 55/55
  migrations reconhecidas e nenhuma pendente após o deploy corrigido;
- aplicação, ingest worker, render worker e webhook worker executando
  `apollo-video:fbbd4c5`, saudáveis e com zero reinícios;
- health, OpenAPI e capability discovery responderam HTTP 200;
- OpenAPI publicou `POST` e `GET`
  `/v1/projects/{projectId}/speech-segments`;
- discovery autenticado publicou
  `apollo.projects.speech-segments.catalog` e
  `apollo.projects.speech-segments.search`.

Smoke autenticado no projeto
`project-fe932791-32f4-4453-8b85-6ce35a711860`:

- `POST` inicial: HTTP 201;
- replay com a mesma idempotency key: HTTP 200 e o mesmo run;
- busca combinada por fala, intenção, pessoa, emoção, roupa e cenário:
  HTTP 200 e um resultado;
- chamada sem credencial: HTTP 401;
- run persistido:
  `speech-catalog-run-0a57512a-e85a-4cd6-9bc4-6f32821f310c`;
- 31/31 segmentos e 294/294 palavras catalogados;
- todos os segmentos persistidos com `physicalMaterialized=false`;
- resultado com direitos aprovados e `eligibleForReuse=true`;
- artifacts físicos permaneceram em 7 antes e depois da catalogação.

O primeiro smoke na imagem `3fd3e55` detectou com segurança uma divergência
entre ranges arredondados dos segmentos e timestamps sobrepostos das palavras:
a API retornou HTTP 422 e não persistiu catálogo nem artifact. A política foi
corrigida para alinhar o texto exato pela ordem canônica das palavras e expandir
o range virtual até os limites das palavras correspondentes. A fixture de
regressão reproduz esse formato e o transcript de produção passou integralmente
antes e depois da implantação de `fbbd4c5`.
