# F2.021 — Modos de prova v1

## Estado

Implementação local integrada ao runtime V2, compiler e Remotion. O requisito
permanece aberto no `TODO.md`: ainda faltam executar o E2E PostgreSQL atualizado
em ambiente seguro, implantar e auditar o mesmo comportamento em produção.

## Resultado implementado

`ProofModeRun` transforma somente avaliações `approved` de
`ProofIntegrityRun` em planos imutáveis por prova e formato.

Modos do MVP:

- `cutaway`: evidência visual em tela inteira;
- `split-screen`: presenter e evidência simultâneos;
- `proof-card`: card tipográfico/estático identificado.

Montage, audio-only e proof-first/cold-open não são aliases desses modos e
permanecem fora deste slice.

## Política

| Entrada | Escolha automática |
| --- | --- |
| áudio/documento | proof-card |
| contexto visual obrigatório | split-screen |
| vídeo/imagem + ritmo rápido | cutaway |
| vídeo medido + 16:9/21:9 | split-screen |
| imagem medida | proof-card |
| demais vídeos medidos | cutaway |

Cutaway e split-screen exigem vídeo/imagem. Contexto obrigatório bloqueia
proof-card. Override manual é permitido por
`proofNeedItemId + format + expectedEvaluationHash`; ele não relaxa essas
invariantes.

## Timing e composição

Cada plano conserva:

- texto exato da claim que o proof-card deve apresentar;
- frame e milissegundo de entrada vindos do ProofNeed;
- range integral aprovado no ProofIntegrity;
- duração mínima, alvo e máxima em frames;
- corte ou crossfade de entrada e saída explícita;
- canvas e safe area do preset canônico;
- regiões separadas para evidência, presenter, crédito e qualifiers;
- contraste mínimo 4,5 e fonte mínima proporcional ao canvas;
- attribution e qualifiers visual/verbal byte a byte iguais;
- contrato `proof-presentation/v1`, sem materializar mídia.

Os 15 goldens cobrem `9:16`, `16:9`, `4:5`, `1:1` e `21:9` nos três modos.

## Persistência

A migration `20260729163000_proof_mode_runs` cria:

- `proof_mode_runs`;
- `proof_mode_plans`;
- vínculos compostos com ProofIntegrity evaluation e ProofNeed item;
- vínculos com EvidenceSegment e media artifact;
- constraints de versão, contagens, modo/mídia, contexto, identificação,
  conteúdo e hashes.

Criação ocorre em transação serializável e revalida:

- ProofIntegrity ID/hash e readiness;
- evaluation, ProofNeed item e presentation hash;
- EvidenceSegment e artifact exatos;
- tipo e disponibilidade da mídia;
- current rights snapshot ainda igual ao snapshot catalogado;
- expiração de rights/consent;
- API client ativo.

Run e planos são hidratados do JSON canônico e comparados às projeções
relacionais.

## API

| Capability | Método e rota |
| --- | --- |
| `apollo.projects.proof-mode-runs.list` | `GET /v1/projects/{projectId}/proof-mode-runs` |
| `apollo.projects.proof-mode-runs.create` | `POST /v1/projects/{projectId}/proof-mode-runs` |
| `apollo.projects.proof-mode-runs.read` | `GET /v1/projects/{projectId}/proof-mode-runs/{runId}` |

A listagem filtra por ProofIntegrity, formato, modo e origem automática/manual.
A criação é bounded, idempotente e não inicia provider, render ou
materialização.

## Interface

O painel “Composição da prova” consome exclusivamente `/v1` e mostra:

- preview proporcional ao canvas;
- regiões de evidência, presenter, crédito, qualifier e safe area;
- modo, formato, timing, transições e contexto;
- attribution e qualifiers obrigatórios;
- origem automática ou manual;
- ações para override por segmento/formato.

Um override cria outro run imutável pela API. Botões que removeriam mídia ou
contexto ficam desabilitados, e o servidor repete a validação.

## Evidência atual

- `tests/v2/proof-mode.test.mjs`: seleção, 15 goldens, overrides, integridade,
  tamper e application service;
- `tests/v2/project-editor-ui.test.mjs`: leitura e override exclusivamente
  pela `/v1`;
- `tests/v2/proof-mode-visual-goldens.integration.mjs`: quinze stills reais nos
  presets canônicos, contact sheet, inspeção de contraste/dimensões e três MP4s
  reais materializados pelo port Remotion;
- contract registry: 160 capabilities, 248 schemas, 280 exemplos e 127 paths;
- migration estática: 104 tabelas, 532 índices e 407 FKs;
- regressão unitária completa: 592/592 testes;
- TypeScript da aplicação e do Remotion, arquitetura V2-only, linguagem de
  domínio, contratos, schema, auditorias de segurança e `git diff --check`
  verdes;
- build de produção Next.js concluído em 159,2 s, registrando as rotas públicas
  de proof mode; bundle Remotion aprovado.

O primeiro run visual detectou dois defeitos que os testes estruturais não
enxergavam: legendas horizontais continuavam sobre a prova e o conteúdo do
proof-card colidia com attribution/qualifiers. O run foi rejeitado. O renderer
passou a ocultar legendas durante toda a janela de proof-presentation, o layout
do card ganhou regiões não sobrepostas e o segundo run foi revisado nas quinze
combinações.

Evidência local aprovada do segundo run:

- 15 PNGs: `9:16`, `16:9`, `4:5`, `1:1` e `21:9` × cutaway,
  split-screen e proof-card;
- MP4 cutaway 9:16:
  `ba8300425fce6d329cacfe70f996798def7f9337926a048ecd61ac7cbe5365ea`;
- MP4 split-screen 16:9:
  `1a1a005860a9c604e01a9ac40142ac0f170590e82c3d71c575c65092a7272d0c`;
- MP4 proof-card 1:1:
  `7f237ca0fbd6579f0a01f14a63678df27e8d6033f5f4671d378a18ddc98e9ae4`;
- nenhuma cena aplicou zoom/pan; attribution e qualifiers permaneceram dentro
  das regiões seguras; a legenda sentinela ficou ausente em todos os formatos.

O cenário T-FR-132 foi acrescentado ao E2E real
`tests/v2/prisma-compatibility-graph.integration.mjs`, incluindo API,
PostgreSQL, replay, mismatch, override, filtros, constraints e contagem
inalterada de artifacts. Ele não foi reexecutado após esta alteração porque a
VPS está explicitamente interditada durante o incidente operacional; isso não
é contado como evidência concluída.

## Pendências de aceite

1. executar o E2E PostgreSQL em ambiente descartável local ou VPS formalmente
   liberada e saudável;
2. implantar e auditar produção;
3. somente então marcar as cinco caixas do F2.021.
