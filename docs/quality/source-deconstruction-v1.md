# F2.015 — Source Deconstruction v1

## 1. Resultado do slice

Este gate entrega a desconstrução semântica de fontes publicadas. A partir de
um master e de seu catálogo temporal de fala, o Apollo identifica abertura,
hook, contexto, corpo, CTA, cauda e elementos que não pertencem ao objetivo
solicitado. O resultado é um `DeconstructionReport` imutável com:

- segmentos classificados e evidência de cada classificação;
- envelope do conteúdo essencial;
- ranges candidatos limpos;
- confiança e score de editabilidade;
- contexto preservado;
- contaminantes semânticos localizados;
- comparação entre a fonte e a seleção limpa;
- decisão automática, revisão humana ou rejeição.

O gate não materializa uma nova mídia. Ele produz o plano verificável que a
limpeza do F2.017 consumirá, preservando o source publicado e sua lineage.

O fluxo pertence exclusivamente ao runtime V2:

- PostgreSQL V2 como fonte de verdade;
- application service único para UI e integrações;
- contratos externos `/v1`;
- autenticação e scopes;
- idempotência obrigatória;
- precondições de hash;
- nenhuma ponte, fallback ou compatibilidade com pipeline antigo.

## 2. Conteúdo essencial e papéis narrativos

Cada `SpeechSegment` ativo é convertido em evidência normalizada com texto
exato, range, completude, intenções catalogadas, hashes e proveniência. O
analisador classifica:

| Papel | Função |
|---|---|
| `opening` | Abertura anterior ao hook |
| `hook` | Promessa, interrupção ou tensão inicial |
| `context` | Fala necessária para completar sentido |
| `body` | Desenvolvimento da mensagem |
| `cta` | Ação solicitada |
| `tail` | Despedida ou sobra terminal |

O caller escolhe `desiredRole` como hook, corpo, CTA ou composição completa e
declara `validationScope` como copy, take, opening edit ou full. A seleção é
explicável: cada segmento registra role confidence, reason codes, estado
essential/included e inclusão exclusiva por contexto.

Aberturas genéricas de material publicado, como apresentação anterior ao
conteúdo, não são confundidas com hook. Uma quebra real de padrão, como
“pare de” ou “preste atenção”, continua no envelope. Caudas de despedida são
removidas. Em um recorte de hook, corpo e CTA aparecem explicitamente como
material não alvo.

## 3. Preservação de fala e contexto

O boundary policy versionado controla:

- pre-roll e post-roll;
- intervalo máximo para juntar segmentos;
- distância máxima para buscar contexto;
- score mínimo de pensamento completo.

Quando o último segmento essencial termina incompleto ou interrompido, o
analisador inclui os segmentos adjacentes necessários até uma fronteira de
pensamento completo. Essa inclusão é marcada como `includedForContext`; ela
não transforma contexto em conteúdo essencial.

Todo range mantém simultaneamente o range editorial, o speech range, os IDs
dos segmentos de origem, papéis, texto exato, confiança, razão de fronteira e
hash próprio. O relatório só recebe decisão automática se o contexto estiver
preservado e o score de editabilidade for pelo menos 70.

## 4. Comparação source versus clean

O `SourceDeconstructionComparison` expõe:

- transcrição original;
- transcrição limpa;
- duração original, limpa e removida;
- ranges limpos e removidos;
- quantidade de segmentos incluídos e excluídos;
- quantidade de segmentos preservados por contexto;
- hash da comparação.

Na tela do projeto, o painel “O que fica. O que sai. Por quê.” usa somente a
API pública. Ele oferece:

- seletor de relatórios;
- alvo, duração limpa, duração removida e decisão;
- mapa temporal da fonte;
- trilha limpa com intervalos preservados e descartados;
- transcrição original com descarte marcado;
- fala limpa;
- lista de contaminantes semânticos.

A revisão foi exercitada em Chromium com viewport desktop de 1440×1000 e
mobile de 390×844. Não houve estouro horizontal nem perda de informação. A
versão do Apollo permanece discreta no canto da tela.

## 5. Golden Reel audiovisual

A fixture versionada
`tests/fixtures/source-deconstruction/reel-published-golden.mp4` é um MP4 real
e determinístico:

- SHA-256
  `7050441e6febd0ff5dab881747cef8564af0cea2c9f1b0a8d88a51aa7b2e60a4`;
- 111.013 bytes;
- H.264 e AAC;
- 320×568;
- 30 fps;
- 6,2 segundos e 186 frames;
- áudio mono de 48 kHz;
- cinco fases visualmente distintas;
- abertura, hook, corpo, CTA e cauda;
- legenda queimada comprovada nos pixels.

O manifest correspondente registra texto exato, ranges, intenção, completude
e expectativas de desconstrução. O teste lê a mídia com FFmpeg, comprova
streams, duração, frames visualmente distintos e contraste dos pixels da
legenda; depois confronta o relatório do domínio com os ranges esperados.

## 6. Persistência PostgreSQL V2

A migration `20260728160000_source_deconstructions` cria:

- `source_deconstruction_reports`;
- `source_deconstruction_segments`;
- `source_deconstruction_ranges`.

Foreign keys carregam workspace e projeto para impedir referências cruzadas.
Constraints validam versões, papéis, decisões, confiança, scores, ranges,
contagens, JSON e hashes. O repositório persiste relatório, projeção de
segmentos e ranges na mesma transação serializável.

Na leitura, o hydrator reconstrói o relatório canônico e cruza JSON, linhas
relacionais, contagens e hashes. Uma alteração controlada no estado
`included` fez a API falhar fechada com `PERSISTENCE_CONFLICT`.

Depois deste gate, o schema possui 89 tabelas de domínio, 437 índices e 328
foreign keys. As três novas tabelas possuem 30 constraints em produção.

## 7. API pública

Quatro capabilities estão presentes no discovery, OpenAPI, schemas
versionados, exemplos e safety policy:

| Capability | Método e rota | Scope |
|---|---|---|
| `apollo.projects.source-deconstructions.list` | `GET /v1/projects/{projectId}/source-deconstructions` | `projects:read` |
| `apollo.projects.source-deconstructions.create` | `POST /v1/projects/{projectId}/source-deconstructions` | `projects:write` |
| `apollo.projects.source-deconstructions.read` | `GET /v1/projects/{projectId}/source-deconstructions/{reportId}` | `projects:read` |
| `apollo.projects.source-deconstructions.comparison.read` | `GET /v1/projects/{projectId}/source-deconstructions/{reportId}/comparison` | `projects:read` |

O contrato público possui 140 capabilities, 220 schemas, 252 exemplos e 113
paths. A criação exige hashes exatos do artifact e transcript, target
composition, escopo, papel desejado e `Idempotency-Key`. Campos desconhecidos
são rejeitados.

Uma repetição da mesma chave e payload devolve o relatório persistido. A mesma
chave com outro payload falha. Hash stale falha antes da análise. Lista,
leitura e comparação são paginadas e isoladas por workspace.

## 8. Regressões e E2E antes do deploy

Resultados do commit técnico `d2bb805`:

- regressão integral: 560/560;
- testes de domínio e Golden Reel: 8/8;
- teste estrutural da UI do projeto: 11/11;
- integração API/PostgreSQL real: 1/1 em 29,2 segundos;
- build Next.js de produção: aprovado;
- typecheck: aprovado;
- lint arquitetural: somente runtime PostgreSQL/API-first;
- linguagem canônica: aprovada;
- contratos públicos: aprovados e baseline compatível;
- schema/migrations: 89 tabelas, 437 índices e 328 foreign keys;
- auditoria npm do app e do Remotion: zero vulnerabilidades;
- `git diff --check`: aprovado.

O E2E real usa um PostgreSQL explicitamente isolado e um servidor Next de
produção. Ele comprova:

- autenticação e ausência de autenticação;
- criação concorrente com um único relatório persistido;
- replay e payload mismatch;
- artifact e transcript hashes stale;
- contrato fechado para campo desconhecido;
- dois relatórios com paginação;
- leitura e comparação;
- transcrições source e clean;
- nenhuma materialização de mídia;
- adulteração relacional detectada;
- constraints de contexto, ranges e scores;
- source sem catálogo ativo rejeitado.

## 9. Evidência de produção

Produção foi validada em 28 de julho de 2026:

- commit técnico/build revision: `d2bb805`;
- imagem: `apollo-video:d2bb805`;
- digest comum ao app e aos três workers:
  `sha256:9ea95b044dbc9266a54e83fe18db26c7dd80499063c4c8cf79b1427caf9145e0`;
- archive exato:
  SHA-256
  `457063641a5d4516369784f6c191567418c5acef3c68f8311667b89e615c5df3`;
- backup anterior à migration:
  `/opt/backups/apollo-video/apollo_video_v2-20260728T191409Z.dump`;
- SHA-256 do backup:
  `bf4b9997c807fdff6b921797f4efd48a352f013595f57fd01d92b25285aa0df6`;
- backup com 1.144.932 bytes e 1.020 entradas válidas no catálogo do
  `pg_restore`;
- migration `20260728160000_source_deconstructions` aplicada;
- 70/70 migrations concluídas e zero falhas;
- app healthy e três workers running;
- quatro `APOLLO_BUILD_REVISION=d2bb805`;
- digest idêntico e restart count zero nos quatro runtimes;
- health público HTTP 200;
- zero erros nos logs após o deploy;
- login HTTP 200 exibindo discretamente a revisão `d2bb805`.

O smoke externo usou a fixture isolada
`source-prod-smoke-d2bb805` e criou o relatório
`source-deconstruction-report-16c108b5-72ca-4835-82c2-d28675d9cfa3`.

| Prova | Resultado |
|---|---|
| Sem autenticação | HTTP 401 |
| Criação | HTTP 201 |
| Replay idempotente | HTTP 200 |
| Payload mismatch | HTTP 409 |
| Artifact hash stale | HTTP 409 |
| Campo desconhecido | HTTP 422 |
| Lista, leitura e comparação | HTTP 200 |
| Decisão | `automatic` |
| Confiança | 0,9689 |
| Editability score | 97 |
| Ranges limpos | 1 |
| Segmentos incluídos/excluídos | 1 / 4 |
| Abertura publicada | removida |
| Hook alvo | preservado |

O relatório persistido possui hash
`e8edba0e3e3bc25ff0cbf59360a6cbe6e566dde709ca009bfd498c883e9761b8`.
Sua projeção relacional contém cinco segmentos e um range limpo; opening
excluído e hook incluído foram confirmados diretamente no PostgreSQL.

## 10. Limite honesto deste gate

F2.015 detecta contaminantes semânticos a partir do catálogo de fala. Ele não
afirma detectar pixels, regiões visuais ou música. Burned captions,
logos/watermarks, borders, overlays e música mixada pertencem ao F2.016. Trim,
crop/reframe, cover e rejeição com derivative pertencem ao F2.017.
