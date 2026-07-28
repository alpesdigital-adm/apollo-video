# F2.010 — Compatibility graph v1

## 1. Resultado do slice

Este gate transforma uma `TakeLibrary` imutável em um grafo auditável de
combinações editoriais. O Apollo V2 agora:

- cria nós somente para hooks, corpos, provas e CTAs elegíveis;
- cruza apenas relações editoriais permitidas;
- aplica incompatibilidades duras antes de qualquer score;
- calcula compatibilidade suave em seis dimensões explicáveis;
- classifica cada edge como `accepted`, `borderline` ou `blocked`;
- persiste reason codes, falhas duras, scores e evidence canônica por edge;
- preserva a identidade e o hash exatos da biblioteca e de cada take;
- permite recalcular sem sobrescrever execuções anteriores;
- expõe criação, leitura e listagem pela API pública `/v1`;
- apresenta o mapa e suas justificativas na interface `/batches`.

Não há grafo paralelo em memória, rota interna privilegiada, fallback ou caminho
de compatibilidade. UI, clientes externos e agentes usam os mesmos application
services e as mesmas três capabilities públicas.

## 2. Nós elegíveis e relações permitidas

O aggregate recebe a identidade e o `runHash` exatos de uma biblioteca já
persistida. O servidor resolve batch, workspace, biblioteca e ator. O payload
não pode substituir texto, papel editorial, source, range, classe ou hashes dos
takes.

Somente takes `primary` ou `alternate` com papel `hook`, `body`, `proof` ou
`cta` tornam-se nós. Takes `rejected`, `needs-review` ou com papel `other`
permanecem preservados na biblioteca, mas não entram automaticamente no grafo.

As relações direcionadas permitidas são:

- hook → body;
- body → proof;
- body → CTA;
- proof → CTA.

Cada nó preserva:

- identidade do graph e do take;
- grupo e `ScriptBlock`, quando existentes;
- papel editorial;
- artifact e hashes de source/take;
- contexto editorial versionado;
- `contextHash` e `nodeHash`.

Nós e edges recebem identidades scoped pelo graph. Duas recalculações da mesma
biblioteca produzem execuções imutáveis distintas, sem colisão e sem permitir
que um edge de uma execução referencie o nó de outra.

## 3. Incompatibilidades duras

As sete regras duras são aplicadas deterministicamente:

| Código | Condição bloqueada |
|---|---|
| `OFFER_MISMATCH` | ofertas incompatíveis |
| `AUDIENCE_CONFLICT` | ausência de audiência compatível |
| `CLAIM_CONTRADICTION` | claims com a mesma chave e valores contraditórios |
| `PERSONA_MISMATCH` | personas incompatíveis |
| `LOCALE_MISMATCH` | locales incompatíveis |
| `CTA_ACTION_MISMATCH` | ação preparada pelo conteúdo diferente da ação do CTA |
| `REQUIRED_CONTINUITY_MISSING` | continuidade obrigatória não fornecida |

Uma falha dura torna o edge inelegível e `blocked`, mesmo quando o score suave é
alto. O banco também impede o estado contraditório `eligible=false` com decisão
`accepted`.

Cada falha inclui código, mensagem e referências de evidence. A hidratação
recalcula regras, contagens e hashes; snapshot adulterado é recusado.

## 4. Score suave em seis dimensões

Edges sem bloqueio duro recebem score ponderado de zero a cem a partir de:

- `narrative`;
- `tone`;
- `energy`;
- `duration`;
- `visual`;
- `experiment`.

Cada dimensão mantém score individual, peso e reason code. O score agregado,
versão da policy e limiares fazem parte do hash da execução. Os limiares
separam:

- `accepted`: combinação elegível acima do limiar de aceite;
- `borderline`: combinação elegível entre os limiares de revisão e aceite;
- `blocked`: qualquer incompatibilidade dura ou score abaixo do limiar mínimo.

O score nunca substitui as regras duras. Um edge bloqueado pode ter 99% de
compatibilidade suave e continuar bloqueado com os sete motivos explícitos.

## 5. Evidence, reason codes e integridade

Cada edge persiste:

- nós de origem e destino;
- relação editorial;
- decisão e elegibilidade;
- score agregado e seis scores individuais;
- hard failures;
- reason codes;
- hashes de take, source e contexto;
- versões das regras e do score;
- `evidenceHash` e `edgeHash`.

O `evidenceHash` vincula a decisão às fontes e às versões exatas usadas. A
hidratação compara JSON canônico, projeções relacionais, contagens e hashes. O
grafo não depende de justificativa livre produzida por LLM para impor segurança.

## 6. Persistência PostgreSQL V2

A migration `20260728010000_compatibility_graphs` cria:

- `compatibility_graph_runs`;
- `compatibility_graph_nodes`;
- `compatibility_graph_edges`.

A migration
`20260728013000_compatibility_graph_node_scope_fk` reforça o isolamento entre
execuções com:

- chave única composta de nó, workspace e graph;
- foreign key composta para o nó de origem;
- foreign key composta para o nó de destino.

As tabelas possuem relações com workspace, projeto, batch, biblioteca e
`ApiClient`. Constraints verificam versões, hashes SHA-256, limiares, contagens,
scores, decisão/elegibilidade, JSON não vazio e unicidade idempotente.

Índices cobrem listagem estável por batch, projeto, biblioteca, decisão, score,
papel editorial, take e execução. O schema reconstruído possui 75 tabelas, 366
índices e 265 foreign keys.

## 7. Concorrência, idempotência e recalculação

A criação exige:

- `Idempotency-Key`;
- `takeLibraryId`;
- `expectedTakeLibraryRunHash`;
- hash de cada take elegível;
- contexto editorial de cada nó;
- limiares explícitos ou defaults versionados.

O fingerprint vincula todos esses dados ao ator. Em transação serializável, a
persistência relê batch, biblioteca e ator antes de gravar.

Comportamentos comprovados:

- replay do mesmo pedido e chave devolve o mesmo graph;
- reutilizar a chave com payload diferente retorna conflito;
- hash obsoleto da biblioteca retorna conflito;
- nova chave cria outra execução imutável;
- nós e edges da nova execução recebem identidades diferentes;
- foreign keys impedem referência entre graphs.

Durante o E2E local, a primeira versão usava identidade global derivada apenas
do take. O recálculo pela UI revelou uma colisão real no PostgreSQL. A identidade
foi corrigida para incluir o `graphId`, a migration ganhou foreign keys scoped e
as regressões passaram a exigir duas recalculações válidas e rejeitar edge
cross-graph.

## 8. API pública

As três capabilities estão em discovery, OpenAPI, schemas versionados, exemplos,
catálogo de tools, safety policy e contratos de concorrência:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.batches.compatibility-graphs.list` | `GET /v1/batches/{batchId}/compatibility-graphs` | `projects:read` |
| `apollo.batches.compatibility-graphs.create` | `POST /v1/batches/{batchId}/compatibility-graphs` | `projects:write` |
| `apollo.batches.compatibility-graphs.read` | `GET /v1/batches/{batchId}/compatibility-graphs/{graphId}` | `projects:read` |

Listagem usa paginação estável. Criação exige o hash exato da biblioteca.
Leitura devolve nós, edges, hard failures, seis scores, reason codes, evidence e
hashes.

Depois deste gate, o contrato público possui 121 capabilities, 195 schemas, 227
exemplos e 99 paths, sem regressão do baseline anterior.

## 9. Interface `/batches`

O painel `Compatibility map` apresenta:

- quantidade de nós;
- combinações aceitas, limítrofes e bloqueadas;
- score médio;
- relação e decisão de cada edge;
- seis medidores de compatibilidade;
- evidence hash;
- todos os hard failures e reason codes;
- seletor de execuções anteriores;
- ação de recálculo.

A UI filtra graphs vinculados à biblioteca ativa e não combina estado stale. O
recálculo chama a mesma capability pública, cria execução imutável e seleciona o
novo resultado.

## 10. Golden graph e regressão

O conjunto `T-FR-083` cobre:

- nós elegíveis para hook, body, proof e CTA;
- exclusão de take rejeitado ou em revisão;
- quatro relações direcionadas;
- sete incompatibilidades duras;
- precedência de hard failure sobre score alto;
- seis dimensões suaves;
- `accepted`, `borderline` e `blocked`;
- reason codes e evidence por edge;
- determinismo de hashes;
- adulteração de snapshot;
- replay idempotente;
- payload conflitante;
- biblioteca obsoleta;
- recalculação imutável;
- identidade scoped por graph;
- foreign key cross-graph;
- constraints de decisão e hash.

Resultados locais:

- regressão integral: 532/532;
- testes unitários focados: 5/5;
- integração PostgreSQL/API real: 1/1;
- typecheck: aprovado;
- lint arquitetural V2-only/PostgreSQL/API-first: aprovado;
- linguagem de domínio: aprovada;
- contrato público: aprovado;
- auditoria npm do app: zero vulnerabilidades;
- auditoria npm do renderer: zero vulnerabilidades;
- build Next.js: aprovado.

O banco isolado `apollo_video_v2_e2e_batches` foi reconstruído no PostgreSQL 16,
recebeu as 65 migrations e executou
`tests/v2/prisma-compatibility-graph.integration.mjs` integralmente.

## 11. E2E local

O fluxo API e UI foi executado com fixture determinística:

- quatro nós elegíveis;
- quatro edges;
- uma combinação aceita;
- uma combinação limítrofe;
- duas combinações bloqueadas;
- sete hard codes;
- seis dimensões suaves;
- recálculo pela UI concluído com HTTP 201;
- desktop 1440 × 1000 sem overflow;
- mobile 390 × 844 sem overflow;
- zero caracteres Unicode de substituição;
- zero percentuais malformados;
- zero erros ou warnings de console.

Screenshots locais:

- `output/playwright/f2010-compatibility-graph-desktop.png`;
- `output/playwright/f2010-compatibility-graph-mobile.png`.

## 12. Evidência de produção

Produção foi validada em 28 de julho de 2026:

- commit e imagem: `958063a` / `apollo-video:958063a`;
- archive exato:
  SHA-256 `d209ee4e8597c532cc14c36e01ef38500780e40ded24eaa3afee35c869eca553`;
- imagem:
  `sha256:7e2deca6be3aaf5f042c8458275bdf7b69f9ca72403abed63241d960c986037a`;
- backup pré-migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260728T014933Z.dump`;
- SHA-256 do backup:
  `cdd66f53f0e9a0e675cb34e38633422e3e72a44566e931f6d6af94148e82e7f7`;
- `pg_restore --list` aprovado;
- migrations `20260728010000_compatibility_graphs` e
  `20260728013000_compatibility_graph_node_scope_fk` aplicadas;
- 65/65 migrations concluídas;
- app healthy e três workers running;
- quatro restart counts iguais a zero;
- health interno e público HTTP 200.

Smoke pela API pública:

- batch: `compat-prod-batch-6b9f7931`;
- alinhamento: `compat-prod-alignment-6b9f7931`;
- biblioteca:
  `take-library-9ef33c71-2b9d-41a6-8669-e6f37a884805`;
- graph golden:
  `compatibility-graph-3450b673-804f-40fe-b95c-7140d36e1f02`;
- graph recalculado:
  `compatibility-graph-afb803eb-4f03-4f58-9f41-f37532fc02cb`;
- acesso sem autenticação: HTTP 401;
- criação: HTTP 201;
- replay exato: HTTP 200;
- mesma chave com payload diferente: HTTP 409;
- hash obsoleto: HTTP 409;
- leitura: HTTP 200;
- listagem: HTTP 200;
- recálculo: HTTP 201;
- três capabilities encontradas;
- quatro nós e quatro edges por execução;
- uma aceita, uma limítrofe e duas bloqueadas;
- sete hard codes e seis dimensões suaves;
- duas execuções, oito nós e oito edges persistidos;
- identidades de nós e edges distintas entre execuções;
- foreign key cross-graph e constraints de decisão/hash comprovadas.

Evidência visual em `https://apollo.alpesd.com.br/batches`:

- versão `958063a` visível;
- graph golden selecionável;
- uma aceita, uma limítrofe e duas bloqueadas visíveis;
- sete hard failures e seis scores visíveis;
- botão `Recalcular mapa` concluiu POST HTTP 201;
- viewport 1440 × 1000 sem overflow;
- viewport 390 × 844 sem overflow;
- os quatro edges permaneceram dentro dos 390 px;
- zero caracteres Unicode de substituição;
- zero percentuais malformados;
- zero erros ou warnings de console;
- screenshots locais:
  `output/playwright/f2010-production-compatibility-desktop.png` e
  `output/playwright/f2010-production-compatibility-mobile.png`.

## 13. Limite honesto deste gate

F2.010 decide e explica quais takes podem ser combinados. Ele ainda não escolhe
uma sequência final H+B+proof+CTA, não compila `StoryPlan`/`EditPlan`, não
materializa `VariantRecipe` e não cria jobs de render.

Essas responsabilidades pertencem a F2.011 e aos gates seguintes. Um edge aceito
é evidência de compatibilidade, não uma ordem para gerar mídia.
