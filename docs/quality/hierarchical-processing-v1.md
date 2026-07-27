# F2.006 — Processamento hierárquico v1

## 1. Resultado do slice

Este gate transforma uma fonte long-form já ingerida no Apollo V2 em uma
estrutura hierárquica pesquisável, sem copiar ou recodificar a mídia:

- chunks imutáveis com núcleo, overlap e time mapping para a fonte;
- evidence spans exatos derivados da transcrição alinhada;
- sinais baratos processados antes de visão e linguagem;
- observations, candidates, moments e chapters vinculados às evidências;
- invalidação transitiva por tier e versão de modelo;
- medição explícita de working set, custo e tempo;
- reprocessamento parcial com idempotência e concorrência serializável.

O resultado usa somente API pública, application services V2 e PostgreSQL V2.
`physicalMaterialized=false` é obrigatório para runs e chunks.

## 2. Evidências de origem

Uma execução vincula identidades e hashes imutáveis de:

- artifact e SHA-256;
- manifest técnico que contém o probe;
- transcript e transcript hash;
- snapshot atual de direitos e consentimento;
- policy de processamento e policy de chunking;
- versões de provider/model por tier;
- ator, idempotency key e request fingerprint.

O manifest técnico e o manifest que originou a transcrição podem ser registros
V2 distintos do mesmo artifact. O repositório exige que ambos pertençam ao
mesmo artifact e projeto, valida o hash canônico de cada registro e confere o
SHA-256 interno do manifest técnico com o artifact persistido.

Essa separação foi necessária e comprovada no master real: a transcrição aponta
para o manifest inicial do upload, enquanto um segundo manifest imutável contém
resolução, duração e fps medidos pelo ingest.

## 3. Chunking e time mapping

`overlapping-time-chunks/v1` recebe:

- duração do master;
- duração do núcleo de cada chunk;
- overlap anterior e posterior.

Cada chunk persiste:

- `coreRangeMs`;
- `sourceRangeMs`;
- `overlapBeforeMs` e `overlapAfterMs`;
- sequência;
- evidence span IDs;
- word, segment e speech counts;
- hash canônico.

O núcleo não se sobrepõe ao núcleo vizinho. A source range inclui o overlap,
limitado a zero e à duração do master. Um evidence span pode aparecer nas
source ranges de dois chunks, mas é atribuído uma única vez ao tier de
linguagem por seu midpoint. A chave física `(runId, chunkId)` permite reutilizar
a mesma identidade lógica em execuções diferentes sem colisão.

## 4. Tiers e ordem de execução

Os quatro tiers são tipados e ordenados:

1. `cheap-signals`;
2. `vision`;
3. `language`;
4. `aggregation`.

O DAG versionado é:

- `cheap-signals`: sem dependências;
- `vision`: depende de `cheap-signals`;
- `language`: depende de `cheap-signals`;
- `aggregation`: depende de `vision` e `language`.

O plano persiste versões, pré-requisitos, sequência, status `process|reuse`,
execution order, invalidated tiers e `planHash`. O banco também persiste uma
execução por tier, com horários, elapsed, working set, custo, output hash e
`reusedFromRunId` quando aplicável.

## 5. Invalidação e reprocessamento parcial

Uma mudança de versão invalida o tier alterado e todos os dependentes
transitivos. Uma mudança de configuração dos chunks invalida os quatro tiers.

No smoke de produção, somente a versão de visão mudou de `1.0.0` para `2.0.0`.
O segundo run executou:

- `cheap-signals`: `reused`;
- `vision`: `processed`;
- `language`: `reused`;
- `aggregation`: `processed`.

Antes de reutilizar um output, o serviço recalcula seu hash e o compara com a
execução anterior. Qualquer alteração persistida fora do contrato falha como
conflito de integridade.

## 6. Moments, chapters e evidência

O tier de linguagem cria candidates por chunk com:

- tópico;
- resumo;
- range exato;
- evidence span IDs;
- salience;
- hash canônico.

A agregação cria moments e chapters preservando todos os evidence span IDs. O
serviço recusa o resultado se qualquer span da entrada desaparecer no tier de
linguagem ou na agregação. Chapters mantêm range total, moment IDs, evidências
e hash; moments mantêm ranges, source chunk, resumo, salience e hash.

## 7. Budget e métricas

O request exige limites explícitos de:

- custo em minor units de USD;
- working set em bytes;
- elapsed em milissegundos.

O serviço faz preflight de custo e memória antes de executar e volta a validar
o consumo observado antes do commit. A cost policy
`hierarchical-cost-policy/v1` atribui custo por chunk e tier. Outputs
reutilizados têm custo, elapsed e working set iguais a zero.

`hierarchical-processing-measurement/v1` persiste duração, chunks, spans,
quantidade de tiers processados/reutilizados, working set, custo, elapsed,
estado bounded e hash.

As fixtures de 30 minutos e duas horas permanecem abaixo dos limites de:

- 256 MiB de working set serializado;
- USD 100,00;
- 30 minutos de execução.

## 8. Contratos públicos

### Executar

- Capability:
  `apollo.projects.hierarchical-processing.runs.create`
- Método: `POST`
- Rota:
  `/v1/projects/{projectId}/hierarchical-processing/runs`
- Scope: `projects:write`
- Idempotência: obrigatória

### Ler

- Capability:
  `apollo.projects.hierarchical-processing.runs.read`
- Método: `GET`
- Rota:
  `/v1/projects/{projectId}/hierarchical-processing/runs/{runId}`
- Scope: `projects:read`

As operações estão no capability discovery, OpenAPI, schemas versionados,
exemplos e catálogo de ferramentas para agentes. O workspace vem da credencial
Bearer. A resposta pública remove idempotency key, request fingerprint e texto
bruto dos evidence spans.

## 9. Persistência e concorrência

As tabelas são:

- `hierarchical_processing_runs`;
- `hierarchical_processing_chunks`;
- `hierarchical_tier_executions`.

Constraints verificam policies, hashes, ranges, status, dependências,
reutilização, budgets, contagens, JSON canônico e ausência de materialização.
Somente um run pode permanecer ativo por artifact + transcript no projeto.

O commit usa transação serializável e revalida:

- artifact, SHA-256 e vínculo com o projeto;
- manifest e manifest hash;
- transcript e transcript hash;
- snapshot e estado atual de direitos;
- ator ativo;
- previous run e run hash.

Conflitos serializáveis recebem retry limitado. Concorrência com a mesma
idempotency key converge para um único run; payload diferente é recusado.

## 10. Evidência automatizada local

Banco isolado `apollo_video_v2_e2e_speech`, recriado do zero:

- 60 migrations aplicadas;
- extensões `vector` e `pg_trgm`;
- 63 tabelas, 314 indexes e 225 foreign keys;
- `T-FR-053`: 6/6 testes de domínio;
- cobertura direcionada de contrato/concorrência: 14/14;
- E2E API/PostgreSQL de duas horas: 1/1;
- regressão integral: 511/511;
- build Next.js 16.2.12 e typecheck: aprovados;
- arquitetura V2-only e linguagem canônica: aprovadas;
- contratos: 105 capabilities, 175 schemas, 204 exemplos e 87 paths;
- auditorias do app e renderer: zero vulnerabilidades conhecidas.

O E2E comprova:

- chunking de duas horas com 24 chunks e overlap;
- evidence spans preservados nos limites;
- manifest técnico distinto do manifest de origem da transcrição;
- primeira execução HTTP 201 e replay HTTP 200;
- leitura HTTP 200;
- payload idempotente divergente, source hash desatualizado e budget
  insuficiente recusados;
- mudança somente de visão invalida visão + agregação;
- concorrência converge em HTTP 200/201;
- constraints SQL bloqueiam materialização e tier reutilizado inconsistente;
- zero novos media artifacts.

## 11. Evidência de produção

Produção validada em 2026-07-27 na revisão final `c083986`:

- backup anterior à migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260727T183803Z.dump`;
- SHA-256 do backup:
  `e610565ec79ca84eeddeffb6f24a8fad6919512a98affdedcdbe8233c8243714`;
- `pg_restore --list` aprovado;
- archive final da revisão exata com SHA-256
  `23b49d2edf33dd5fad2d47e76ab89112abb22b9562a64504e6b08e02003f5483`;
- imagem `apollo-video:c083986`, ID
  `sha256:dd1eda20ecc261f0f824ecfe071dbddf0869063a68840cabe316ec56b3572b1e`;
- migration `20260727180000_hierarchical_processing` aplicada;
- 60/60 migrations atuais;
- web, ingest, render e webhook na mesma imagem, zero reinícios e web healthy;
- health público HTTP 200;
- acesso sem Bearer recusado com HTTP 401;
- os dois capabilities presentes na descoberta autenticada;
- primeira execução HTTP 201, replay HTTP 200 e leitura HTTP 200;
- primeiro run:
  `hierarchical-processing-run-1f755c37-fdc5-4bf2-8d0e-2bf3e1e58e05`;
- primeiro run hash:
  `18f2782d9254555d111b622af325f28d795905678b29d4500afac8a0b5b806c7`;
- 2 chunks, 31 evidence spans, 1 chapter e 2 moments;
- custo de 12 minor units, working set de 28.418 bytes e elapsed de 18 ms;
- segundo run:
  `hierarchical-processing-run-fdf946ba-13fa-46e3-9918-eea477cbe24c`;
- segundo run hash:
  `22b59055e60ab367665cfac45c1d8984c3cac7182adcaf5b1c04e88dfb937c1e`;
- invalidação exata `vision, aggregation`;
- statuses `reused, processed, reused, processed`;
- 2 runs, 1 ativo, 4 chunks e 8 tier executions persistidos;
- zero runs/chunks materializados;
- media artifacts permaneceram em 7 antes/depois.

