# F2.008 — Importação e script alignment v1

## 1. Resultado do slice

Este gate transforma um roteiro planejado e uma ou mais transcrições canônicas
do lote em um mapa auditável entre intenção e gravação. O Apollo V2 agora:

- importa hooks, corpos, provas, objeções, pontes, ofertas e CTAs identificados;
- preserva, byte a byte, o texto original e a ordem do documento;
- deriva normalização e tokens sem substituir o original;
- alinha cada bloco a palavras persistidas da transcrição e ao range temporal;
- classifica correspondências `exact`, `near`, `partial` e `missing`;
- identifica falas gravadas fora do roteiro como `extra take`;
- registra confiança, evidência, desvios e ambiguidade;
- exige decisão explícita quando a automação não alcança o limiar;
- permite revisar blocos e takes extras sem apagar a análise anterior;
- expõe todo o fluxo pela API pública `/v1` e pela interface `/batches`.

Não existe implementação paralela, fallback em memória ou caminho de
compatibilidade. A UI usa as mesmas quatro capabilities públicas disponíveis
para clientes externos.

## 2. Documento importado e papéis editoriais

O parser aceita um marcador por bloco:

- `HOOK` ou `GANCHO`;
- `BODY` ou `CORPO`;
- `PROOF` ou `PROVA`;
- `OBJECTION` ou `OBJEÇÃO`;
- `BRIDGE` ou `PONTE`;
- `OFFER` ou `OFERTA`;
- `CTA`.

Cada bloco recebe identidade estável, sequência, papel, rótulo, texto exato,
texto normalizado, tokens derivados e offsets no documento original. O
documento completo retém o `rawText`, locale, título, delimitadores e hash.

A hidratação da persistência recalcula e verifica:

- identidade e ordem de todos os blocos;
- offsets e slices do texto bruto;
- hashes do documento e da execução;
- consistência entre original, normalizado e tokens;
- ausência de campos desconhecidos ou estado adulterado.

Normalização serve apenas à comparação. Pontuação, caixa, espaços, acentos e
redação enviados pelo operador permanecem disponíveis exatamente como foram
importados.

## 3. Alinhamento com evidência canônica

Cada source precisa pertencer a um `sourceGroup` do batch e declarar:

- `transcriptId`;
- `expectedTranscriptHash`;
- pista opcional de papel.

O servidor resolve a transcrição no PostgreSQL e usa suas palavras persistidas.
Texto, timecode ou confidence enviados pelo navegador nunca substituem essa
fonte canônica.

O alinhador percorre os blocos em ordem e mantém a seleção monotônica dentro
de cada gravação. Para cada candidato registra:

- transcrição e artefato de origem;
- índices inicial e final das palavras;
- índices exatos usados como evidência;
- texto falado;
- `startMs` e `endMs`;
- confidence total e componentes da pontuação;
- cobertura do planejado e do falado;
- desvios classificados;
- motivo de seleção ou rejeição.

Ranges sobrepostos ou regressivos são recusados. Quando há candidatos
equivalentes, o estado fica ambíguo em vez de inventar precisão.

## 4. Classificação e desvios

As classes de bloco são:

- `exact`: texto normalizado integralmente equivalente;
- `near`: pequena diferença com cobertura suficiente;
- `partial`: somente parte relevante foi gravada;
- `missing`: evidência insuficiente ou inexistente.

Palavras não atribuídas a blocos planejados formam `extra takes`, com
transcrição, artefato, range, texto, hash e estado de revisão próprios.

O resultado também registra desvios como:

- omissão;
- inserção;
- paráfrase;
- repetição;
- alteração de número ou claim;
- ordem divergente.

Confidence abaixo de 80%, ambiguidade, desvio material, bloco ausente ou take
extra exigem revisão. A automação não converte incerteza em aprovação.

## 5. Revisão e imutabilidade histórica

A revisão aceita decisões explícitas para blocos e takes extras. Entre elas:

- aceitar ou rejeitar candidato;
- marcar bloco como ausente;
- aceitar ou rejeitar take extra;
- registrar nota limitada.

Cada mutation exige `Idempotency-Key` e `expectedRevision`. O repositório usa
transação serializável e compare-and-swap. Revisão concorrente com revision
antiga retorna conflito, e replay idempotente devolve exatamente o resultado
original.

O review cria um registro separado com:

- decisões;
- revision esperada e resultante;
- ator;
- hash do review;
- snapshot integral do resultado;
- hash do resultado;
- fingerprint e chave idempotente.

Assim, uma escolha humana atualiza o estado efetivo sem apagar a execução ou a
evidência anterior.

## 6. Persistência PostgreSQL V2

A migration `20260727210000_script_alignments` cria:

- `script_alignment_runs`;
- `script_alignment_reviews`.

As tabelas se relacionam com workspace, projeto, batch e `ApiClient`. Constraints
validam versões, status, revisions, contagens, hashes, tamanhos dos JSONs,
fingerprints e coerência temporal.

Índices cobrem:

- listagem estável por batch e data;
- busca por projeto, status e pendências;
- idempotência por workspace, ator e chave;
- histórico ordenado de reviews;
- unicidade da revision resultante.

O schema limpo possui 70 tabelas, 340 índices e 246 foreign keys.

## 7. API pública

As quatro capabilities estão no discovery, OpenAPI, schemas versionados,
exemplos, catálogo de tools, safety policy e contratos de concorrência:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.script-alignments.list` | `GET /v1/batches/{batchId}/script-alignments` | `projects:read` |
| `apollo.batches.script-alignments.create` | `POST /v1/batches/{batchId}/script-alignments` | `projects:write` |
| `apollo.batches.script-alignments.read` | `GET /v1/batches/{batchId}/script-alignments/{alignmentId}` | `projects:read` |
| `apollo.batches.script-alignments.reviews.apply` | `POST /v1/batches/{batchId}/script-alignments/{alignmentId}/reviews` | `projects:write` |

Listagem usa paginação estável e não aceita workspace no payload. A criação
preserva o roteiro e resolve todas as fontes no servidor. Leitura devolve o
mapa completo de evidências. Review exige revision e decisão por alvo.

## 8. Interface `/batches`

A aba `Roteiro & takes` apresenta:

- importação do roteiro por marcadores;
- título e locale;
- escolha das transcrições canônicas do lote;
- pista opcional de papel por fonte;
- limiares de decisão automática e revisão;
- slate ordenado dos blocos;
- papel, classificação, confidence e timecode;
- comparação entre planejado e falado;
- badges de desvios;
- pendências e decisões registradas;
- takes extras preservados.

O modal de importação impede overflow interno em telas estreitas com largura
limitada, `min-width: 0` nos filhos e contenção horizontal. A versão publicada
continua visível discretamente no canto da tela.

## 9. Golden set e regressão

O conjunto `T-FR-081` cobre explicitamente:

- roteiro com hook, corpo, prova e CTA;
- preservação exata do texto e da ordem;
- correspondência exata;
- pequena paráfrase;
- repetição;
- erro de fala;
- gravação fora da ordem planejada;
- bloco parcial;
- bloco ausente;
- take extra;
- alteração de número/claim;
- candidatos ambíguos;
- monotonicidade dos ranges;
- revisão de bloco e extra take;
- idempotência de criação e review;
- conflito de revision;
- adulteração de hashes e snapshots.

Resultados locais:

- regressão integral: 524/524;
- typecheck: aprovado;
- lint arquitetural V2-only/PostgreSQL/API-first: aprovado;
- validação de linguagem de domínio: aprovada;
- contratos: 114 capabilities, 186 schemas, 218 exemplos e 94 paths;
- schema: 70 tabelas, 340 índices e 246 foreign keys;
- auditoria npm do app: zero vulnerabilidades;
- auditoria npm do renderer: zero vulnerabilidades;
- build Next.js 16.2.12: aprovado.

O banco isolado `apollo_video_v2_e2e_batches` foi destruído e recriado no
PostgreSQL 16. As extensões `vector`, `pg_trgm` e `pgcrypto` foram criadas antes
do deploy das 62 migrations. O E2E real
`test:integration:script-alignments` passou sobre esse banco reconstruído.

## 10. Evidência de produção

Produção foi validada em 2026-07-27:

- commit e imagem: `8eb7377` / `apollo-video:8eb7377`;
- archive exato:
  SHA-256 `5411fe1f689cda43ffd326677532aa195f2d644a1a9a8e524a47d18880a55a3f`;
- imagem:
  `sha256:efbc033b86651e40db4645fe1403f6268b533c8a27d8b905f8979fac83e755d7`;
- backup pré-migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260727T221804Z.dump`;
- SHA-256 do backup:
  `d58bca86c29b2f6fc14283b581b2bc49e4dcb1807f83c62a51fcea488ea5e4d1`;
- `pg_restore --list` aprovado;
- migration `20260727210000_script_alignments` aplicada;
- 62/62 migrations aplicadas;
- app healthy, três workers running e quatro restart counts iguais a zero;
- health público HTTP 200.

Smoke pela API pública:

- batch:
  `production-batch-b5f5a29c-3554-4f62-81b2-e225066b7cee`;
- alinhamento:
  `script-alignment-8eccee8c-c61b-453e-8a7f-80dd7c78e5c8`;
- acesso sem autenticação: HTTP 401;
- criação: HTTP 201;
- replay exato da criação: HTTP 200;
- criação do review: HTTP 201;
- replay exato do review: HTTP 200;
- leitura: HTTP 200;
- listagem: HTTP 200;
- quatro capabilities encontradas;
- texto exato preservado;
- 12 palavras canônicas usadas como evidência;
- um bloco e um take extra;
- revision final 2;
- status final `reviewed`;
- zero pendências.

Evidência visual em `https://apollo.alpesd.com.br/batches`:

- versão `8eb7377` visível;
- resultado apresenta planejado, falado, confidence, timecode, desvios e extra;
- modal desktop mostra texto e fontes canônicas;
- viewport 1440 × 1000 sem overflow horizontal;
- viewport 390 × 844 sem overflow no documento, dialog, form, inputs ou textarea;
- dialog mobile integralmente contido no viewport;
- zero caracteres Unicode de substituição;
- zero erros de console;
- screenshots locais:
  `output/playwright/f2008-production-alignment-result-desktop.png`,
  `output/playwright/f2008-production-mobile-modal.png` e
  `output/playwright/f2008-production-script-slate-desktop.png`.

## 11. Limite honesto deste gate

F2.008 identifica blocos e onde eles foram gravados, mas ainda não escolhe o
melhor take entre várias performances nem protege uma escolha editorial. Isso
pertence à F2.009.

O gate também não decide quais hooks, corpos, provas e CTAs combinam entre si,
não compila variantes e não expande combinações automaticamente. Compatibility
graph, `VariantRecipe` e controle da explosão combinatória permanecem nos gates
F2.010 a F2.012.
