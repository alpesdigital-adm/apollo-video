# F2.016 — diagnóstico de contaminação de fontes

## Resultado entregue

O Apollo V2 recebe sinais estruturados de um detector identificado, cruza-os com
os trechos de fala preservados pelo `SourceDeconstructionReport` e com regiões
visuais protegidas, e persiste um `ContaminationReport` imutável. O relatório:

- reconhece `burned-caption`, `logo-watermark`, `music`, `border` e `overlay`;
- preserva o range temporal exato, a região normalizada e a confiança de cada
  observação;
- calcula sobreposição temporal entre achados e fala essencial;
- calcula interseção espacial com rosto, pessoa, texto essencial, produto ou
  conteúdo de tela;
- classifica a remoção como `safe`, `review-required` ou `destructive`;
- impede o Diretor de planejar remoção quando ela destruiria fala ou pixels
  essenciais;
- separa o diagnóstico acionável do Diretor das perguntas destinadas à revisão
  humana;
- nunca modifica nem materializa a fonte durante o diagnóstico.

Este gate entrega a fronteira normalizada para detectores internos ou externos.
O request registra `provider`, `model`, `version`, sinais e confidence e rejeita
campos livres. Portanto, um adapter de visão/áudio pode evoluir sem alterar o
domínio. O gate não afirma que o Apollo treinou um modelo proprietário, não
executa limpeza e não substitui a limpeza F2.017 nem a limpeza avançada F3.017.

## Fluxo V2

`Detector/IA → POST /v1 → application service → domínio canônico → transação
serializable → PostgreSQL V2 → GET /v1 → Diretor, agente externo e UI`

Não há rota `/api`, SQLite, dual-write, fallback ou adapter de compatibilidade.
O `sourceDeconstructionReportHash` e o SHA-256 do artifact são revalidados antes
da gravação. Replay exige a mesma combinação de ator, idempotency key e
fingerprint; payload diferente retorna conflito.

## Persistência

A migration `20260728200000_contamination_reports` adiciona cinco tabelas:

- `contamination_reports`;
- `contamination_observations`;
- `contamination_protected_regions`;
- `contamination_findings`;
- `contamination_overlaps`.

As projeções possuem FKs compostas de workspace/projeto, hashes canônicos,
checks de range/região/confidence, decisão, impacto e JSON, além de índices de
paginação e busca operacional. A hidratação recalcula o relatório e rejeita
qualquer divergência entre JSON canônico e projeções relacionais.

## API pública

| Capability | Método e caminho | Escopo |
| --- | --- | --- |
| `apollo.projects.contamination-reports.list` | `GET /v1/projects/{projectId}/contamination-reports` | `projects:read` |
| `apollo.projects.contamination-reports.create` | `POST /v1/projects/{projectId}/contamination-reports` | `projects:write` |
| `apollo.projects.contamination-reports.read` | `GET /v1/projects/{projectId}/contamination-reports/{reportId}` | `projects:read` |
| `apollo.projects.contamination-reports.diagnostics.read` | `GET /v1/projects/{projectId}/contamination-reports/{reportId}/diagnostics` | `projects:read` |

O endpoint de diagnóstico aceita `audience=director`, `human-review` ou `all`.
Todas as quatro operações possuem capability ID, schemas versionados,
OpenAPI, exemplos, segurança de agente e testes de contrato.

## Evidência audiovisual

`tests/fixtures/contamination` contém seis MP4 H.264/AAC determinísticos:

- uma fixture para cada um dos cinco tipos;
- uma combinação com todos os tipos sobrepostos.

Os testes leem bytes reais com FFmpeg/FFprobe, verificam SHA-256, codec,
dimensão, FPS, duração, pixels das áreas contaminadas e RMS do áudio. O
manifest associa esses sinais audiovisuais às observações exatas usadas pelo
contrato do detector.

## Interface

O editor de projeto consome exclusivamente a API `/v1` e exibe:

- mapa de risco no aspect ratio do projeto;
- regiões protegidas e achados seguros/bloqueados;
- range, coordenadas e confidence;
- resumo de achados, remoções seguras e preservações;
- decisão do Diretor;
- perguntas localizadas para revisão humana.

A inspeção visual local corrigiu legibilidade, pluralização e concordância das
mensagens. A regressão estrutural garante que a UI continue usando apenas os
contratos públicos.

## Evidência de teste e produção

Correção de concorrência Wave 24: após três tentativas
serializáveis com `P2034`, a criação consulta a linha vencedora pela chave de
idempotência no mesmo workspace, projeto e cliente. O replay só é aceito quando
o contexto de autenticação e o fingerprint da requisição coincidem; a leitura
reidrata e valida o source, o relatório canônico e suas projeções. Sem vencedor,
o erro permanece `PERSISTENCE_CONFLICT`; divergência de contexto ou payload
permanece `IDEMPOTENCY_PAYLOAD_MISMATCH`. O caminho `P2002` continua com a mesma
reconciliação. Regressões determinísticas cobrem esses casos e uma projeção
corrompida. A prova RED local `w24-contamination-red-20260925-bf04997b`
reproduziu o conflito anterior após `P2034` exaurido. A prova GREEN local
`w24-contamination-green-hash-20260925-80410259` passou `1/1` na jornada
API + PostgreSQL isolado + worker + FFmpeg + revisão, incluindo a reconciliação
`P2034`/`P2002` e os seis cenários de regressão. Também passaram localmente
`2520/2520` testes unitários, arquitetura, ESLint e build Next + TypeScript.
O banco isolado foi encerrado sem conexões remanescentes. CI do novo commit e
aceitação em produção desta correção continuam pendentes.

As evidências abaixo são históricas da entrega F2.016 (`e00727f`); seus
números e seu smoke de produção não validam a correção Wave 24:

- commit técnico: `e00727f`;
- regressão geral: `564/564`;
- testes do domínio, goldens e long-form: `16/16`;
- regressões da interface do editor: `12/12`;
- E2E real API + PostgreSQL isolado: `1/1`;
- contratos: 144 capabilities, 225 schemas, 257 exemplos e 116 paths;
- migration verifier: 94 tabelas, 458 índices e 348 FKs no schema completo;
- auditorias de segurança principal e Remotion: zero vulnerabilidades;
- produção: imagem/revisão `apollo-video:e00727f`, app saudável e três workers
  ativos, todos com `RestartCount=0`;
- PostgreSQL de produção: 71 migrations aplicadas;
- smoke público: relatório
  `contamination-report-9784067e-3d23-485c-b90b-de68a34e75b0`, hash
  `dbf8113ee6b3d343af07d46ec3197e3b1e979ed0d2f65a303ad1de9cf7f566df`;
- smoke: cinco tipos, cinco overlaps, três achados seguros, dois destrutivos e
  revisão humana obrigatória;
- respostas do smoke: sem autenticação `401`, criação concorrente `200/201`,
  replay `200`, mismatch `409`, hash stale `409`, campo desconhecido `422` e
  list/read/diagnostics `200`;
- prova SQL: cinco tabelas, 26 índices, 48 constraints, cinco observations,
  uma região protegida, cinco findings, cinco overlaps e somente um vínculo de
  mídia no projeto — diagnóstico não materializou artifact.

## Limites deliberados

- F2.016 diagnostica; F2.017 consome este laudo para escolher e executar trim,
  crop/reframe, cover ou reject sem alterar o source.
- Separação de stems, inpainting e restauração pertencem à limpeza avançada.
- O detector pode ser trocado por adapter sem alterar o relatório canônico.
- Nenhum achado destrutivo pode ser convertido em remoção automática por prompt
  ou por confiança isolada.
