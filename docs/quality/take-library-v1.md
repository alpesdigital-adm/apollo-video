# F2.009 — Biblioteca de takes v1

## 1. Resultado do slice

Este gate transforma um `ScriptAlignment` canônico em uma biblioteca auditável
de performances. O Apollo V2 agora:

- agrupa material pelo `ScriptBlock` esperado ou por intenção inferida;
- separa retakes consecutivos sem recortar ou substituir a mídia de origem;
- atribui um `retakeBoundaryId` obrigatório e único a cada take;
- avalia completude, performance, áudio, vídeo e integridade;
- distingue evidência medida de dimensão indisponível;
- classifica takes como `primary`, `alternate`, `rejected` ou `needs-review`;
- preserva o artefato, o range e o hash de origem em todas as classificações;
- permite seleção manual e proteção de um take elegível;
- exige confirmação explícita para substituir uma escolha protegida;
- mantém histórico imutável das seleções;
- expõe todo o fluxo pela API pública `/v1` e pela interface `/batches`.

Não existe implementação paralela em memória, rota interna privilegiada, fallback
ou caminho de compatibilidade. A interface usa as mesmas quatro capabilities
públicas disponíveis para clientes externos.

## 2. Agrupamento por roteiro ou intenção

A criação recebe a identidade e o hash exatos de um alinhamento já persistido. O
servidor resolve o alinhamento dentro do workspace e do batch; o cliente não pode
substituir blocos, fontes, ranges ou texto canônico pelo payload.

Cada take planejado pertence a um grupo com:

- `groupKind: script-block`;
- identidade e papel do `ScriptBlock`;
- texto e ordem planejados;
- evidência do alinhamento;
- confidence normalizada no intervalo de zero a um.

Material extra permanece disponível em um grupo com:

- `groupKind: inferred-intention`;
- intenção inferida;
- evidência usada na inferência;
- confidence própria;
- vínculo com a mesma fonte canônica.

O agrupamento inferido não transforma material fora do roteiro em conteúdo
aprovado. No smoke de produção, a fala longa que contém datas foi preservada
como take de intenção inferida e classificada como `rejected`; ela não compõe uma
saída final deste gate.

## 3. Retake boundaries

Cada trecho candidato recebe um `retakeBoundaryId` determinístico derivado da
fonte, range temporal, alinhamento e posição no grupo. A hidratação valida que:

- todo take possui boundary;
- boundaries são únicas dentro da execução;
- `startMs` é menor que `endMs`;
- ordem, range e fonte são consistentes com a evidência;
- o hash do source continua presente;
- retakes consecutivos do mesmo bloco continuam sendo takes independentes.

Assim, duas performances do mesmo texto não são fundidas por coincidência de
conteúdo e nenhuma separação exige materializar ou alterar o vídeo bruto.

## 4. Avaliação em cinco dimensões

Cada take possui exatamente cinco dimensões tipadas:

- `completeness`;
- `performance`;
- `audio`;
- `video`;
- `integrity`.

Uma dimensão pode ser:

- medida, com score, confidence, método e evidence;
- indisponível, com reason code explícito.

O domínio recusa dimensão duplicada, score fora do intervalo, evidence
inconsistente e estado parcial. Completude e integridade podem usar evidência
canônica do alinhamento; performance, áudio e vídeo aceitam medições autorizadas.
Quando uma medição não existe, o Apollo registra ausência em vez de inventar
qualidade.

A classificação é derivada da combinação entre elegibilidade, scores, confidence
e limiares versionados. O payload do navegador não escolhe diretamente a classe.

## 5. Classificação e preservação da fonte

As quatro classes têm semântica explícita:

- `primary`: melhor take elegível do grupo;
- `alternate`: alternativa elegível preservada;
- `rejected`: evidência suficiente para não usar automaticamente;
- `needs-review`: automação sem segurança para decidir.

Todos os estados retêm:

- `artifactId`;
- `transcriptId`;
- `sourceHash`;
- `startMs` e `endMs`;
- texto falado;
- boundary;
- avaliações e evidence;
- reason codes de classificação.

Rejeitar ou trocar a seleção não apaga o source. A hidratação recalcula hashes,
projeções, contagens e classes e recusa snapshot adulterado.

## 6. Seleção manual e proteção

A seleção manual somente aceita take elegível do grupo correto. A mutation exige:

- `Idempotency-Key`;
- `expectedRevision`;
- identidade do grupo;
- identidade do take;
- decisão de proteger ou não;
- confirmação do take protegido que será substituído, quando aplicável.

Uma escolha protegida não pode ser trocada silenciosamente. O servidor exige a
identidade exata da proteção anterior, executa compare-and-swap em transação
serializável e cria uma nova revision. Revision obsoleta retorna conflito.
Replay idempotente devolve o mesmo resultado.

O histórico registra a seleção, o ator, a proteção substituída, os hashes do
pedido e do resultado e o snapshot integral da nova revision.

## 7. Persistência PostgreSQL V2

A migration `20260727230000_take_libraries` cria:

- `take_library_runs`;
- `take_library_selections`.

As tabelas se relacionam com workspace, projeto, batch, alinhamento e
`ApiClient`. Constraints verificam versões, status, revisions, contagens,
hashes, tamanhos de JSON, fingerprints e coerência temporal.

Índices cobrem:

- listagem estável por batch;
- busca por projeto e status;
- alinhamentos já avaliados;
- pendências de revisão;
- idempotência por workspace e ator;
- histórico ordenado de seleções;
- unicidade da revision resultante.

O schema limpo possui 72 tabelas, 350 índices e 254 foreign keys.

## 8. API pública

As quatro capabilities estão no discovery, OpenAPI, schemas versionados,
exemplos, catálogo de tools, safety policy e contratos de concorrência:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.take-libraries.list` | `GET /v1/batches/{batchId}/take-libraries` | `projects:read` |
| `apollo.batches.take-libraries.create` | `POST /v1/batches/{batchId}/take-libraries` | `projects:write` |
| `apollo.batches.take-libraries.read` | `GET /v1/batches/{batchId}/take-libraries/{libraryId}` | `projects:read` |
| `apollo.batches.take-libraries.selections.apply` | `POST /v1/batches/{batchId}/take-libraries/{libraryId}/selections` | `projects:write` |

Listagem usa paginação estável. Criação vincula o hash exato do alinhamento.
Leitura devolve grupos, takes, avaliações, classificação e histórico. Seleção
manual exige revision e proteção explícita.

Depois deste gate, o contrato público possui 118 capabilities, 191 schemas, 223
exemplos e 97 paths, sem regressão do baseline anterior.

## 9. Interface `/batches`

O painel `Take room` apresenta:

- contagem de grupos, takes, protegidos e itens para revisão;
- separação entre bloco do roteiro e intenção inferida;
- cartões independentes por retake;
- source hash e range preservados;
- classe editorial;
- cinco medidores de qualidade;
- confidence de atribuição;
- ação de seleção e troca de proteção.

O estado protegido fica visível no grupo e no take. A UI não permite selecionar
um take rejeitado e explica que a fonte foi preservada depois de uma troca.

## 10. Golden set e regressão

O conjunto `T-FR-082` cobre explicitamente:

- dois retakes consecutivos para o mesmo `ScriptBlock`;
- boundary obrigatória e única;
- grupo por bloco previsto;
- grupo por intenção inferida;
- cinco dimensões medidas;
- dimensões indisponíveis;
- `primary`, `alternate`, `rejected` e `needs-review`;
- preservação de artifact, range, texto e source hash;
- seleção manual;
- proteção;
- substituição protegida explícita;
- replay idempotente;
- conflito de revision;
- take rejeitado não selecionável;
- dimensão duplicada ou inválida;
- hash e snapshot adulterados;
- alinhamento ou evidence obsoletos;
- confidence normalizada de zero a um.

Durante o E2E foi detectada uma inconsistência entre confidence inferida, já
normalizada, e confidence de alinhamento, originalmente expressa de zero a cem.
O domínio passou a normalizar ambas para zero a um, a UI converte uma única vez
para percentual e a regressão recusa qualquer valor fora desse intervalo.

Resultados locais:

- regressão integral: 528/528;
- testes focados: 9/9;
- integração PostgreSQL/API real: 1/1;
- typecheck: aprovado;
- lint arquitetural V2-only/PostgreSQL/API-first: aprovado;
- validação de linguagem de domínio: aprovada;
- validação do contrato público: aprovada;
- auditoria npm do app: zero vulnerabilidades;
- auditoria npm do renderer: zero vulnerabilidades;
- build Next.js: aprovado;
- build da imagem Docker: aprovado.

O banco isolado `apollo_video_v2_e2e_batches` foi reconstruído no PostgreSQL 16
e recebeu as 63 migrations. O E2E
`tests/v2/prisma-take-library.integration.mjs` passou sobre esse banco real.

## 11. E2E local

O fluxo API e UI foi executado com fixture determinística:

- biblioteca com dois grupos e quatro takes;
- um take principal protegido;
- dois alternativos;
- um rejeitado;
- source original preservado;
- seleção manual e troca protegida concluídas;
- confidences exibidas como 95% e 97%, sem `9700%`;
- desktop 1440 × 1000 sem overflow;
- mobile 390 × 844 sem overflow;
- zero caracteres Unicode de substituição;
- zero erros ou warnings de console.

Screenshots locais:

- `output/playwright/f2009-take-room-desktop-final.png`;
- `output/playwright/f2009-batches-desktop-final.png`;
- `output/playwright/f2009-take-room-mobile-final.png`.

## 12. Evidência de produção

Produção foi validada em 2026-07-27 e 2026-07-28:

- commit e imagem: `3241ade` / `apollo-video:3241ade`;
- archive exato:
  SHA-256 `ca8d20bfc642f9d3f35d9278bd4d9348af7efd140d97ca2b843e1fecf62e23c3`;
- imagem:
  `sha256:7e4a6392129787b112835011e4364b200cc4486a7b03cce27614d5d50683f982`;
- backup pré-migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260728T001540Z.dump`;
- SHA-256 do backup:
  `3481c1da91cbafedd521d3e08749c131524b1b3ccc5615e15308898b6175617f`;
- `pg_restore --list` aprovado;
- migration `20260727230000_take_libraries` aplicada;
- 63/63 migrations aplicadas;
- app healthy e três workers running;
- quatro restart counts iguais a zero;
- health público HTTP 200.

Smoke pela API pública:

- batch:
  `production-batch-b5f5a29c-3554-4f62-81b2-e225066b7cee`;
- alinhamento:
  `script-alignment-8eccee8c-c61b-453e-8a7f-80dd7c78e5c8`;
- biblioteca:
  `take-library-d5571b34-2d35-44b9-84e9-8888f8fda6b0`;
- acesso sem autenticação: HTTP 401;
- criação: HTTP 201;
- replay exato da criação: HTTP 200;
- pedido com hash obsoleto: HTTP 409;
- leitura: HTTP 200;
- listagem: HTTP 200;
- seleção protegida: HTTP 201;
- replay exato da seleção: HTTP 200;
- quatro capabilities encontradas;
- revision final 2;
- status final `reviewed`;
- dois grupos e quatro takes;
- um primary, dois alternates e um rejected;
- um take protegido;
- zero pendências de revisão;
- source preservado;
- todas as confidences no intervalo de zero a um.

Evidência visual em `https://apollo.alpesd.com.br/batches`:

- versão `3241ade` visível;
- biblioteca real com grupos planejado e inferido;
- classe, range, source, cinco dimensões e confidence visíveis;
- primary protegido e duas ações de troca;
- viewport 1440 × 1000 com documento, painel e grupo integralmente contidos;
- viewport 390 × 844 com documento, painel e grupo integralmente contidos;
- zero caracteres Unicode de substituição;
- zero erros ou warnings de console;
- screenshots locais:
  `output/playwright/f2009-production-take-room-desktop.png`,
  `output/playwright/f2009-production-batches-desktop.png`,
  `output/playwright/f2009-production-take-room-mobile.png` e
  `output/playwright/f2009-production-take-room-mobile-full.png`.

## 13. Limite honesto deste gate

F2.009 organiza, avalia e protege takes, mas ainda não decide quais hooks,
corpos, provas e CTAs são compatíveis entre si. Isso pertence à F2.010.

O gate também não compila `VariantRecipe`, não controla a explosão combinatória
e não gera o MP4 final. A fala longa rejeitada permanece no catálogo porque a
regra deste gate é preservar a fonte; removê-la de uma composição final depende
dos gates de compatibilidade, recipe, planejamento e render posteriores.
