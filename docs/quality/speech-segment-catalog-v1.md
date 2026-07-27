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

- unit/regressão: 484/484;
- integração PostgreSQL/API: 1/1;
- build Next.js: aprovado;
- typecheck: aprovado;
- arquitetura V2-only: aprovada;
- contratos públicos: 93 capabilities, 155 schemas, 182 examples e 78 paths;
- migration bootstrap limpo: aprovado.

## 7. Evidência de produção

Esta seção só será preenchida após migration, smoke autenticado e consulta
direta no PostgreSQL de produção. O `TODO.md` não deve ser marcado antes
dessa comprovação.
