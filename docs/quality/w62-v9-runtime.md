# W62 — runtime do detector V9: evidência de rostos por janela, primeiro plano, orador e área de legenda

Branch local `claude/w62-v9-runtime` (sem push). Este documento descreve o que foi construído, o que foi
verificado, o que **não** foi executado e o que bloqueia a implantação. O aceite do proprietário e seus
limites estão em `docs/quality/w62-v9-owner-acceptance.md` (endereçado por hash; o envelope o cita).

## Estado em uma frase

O runtime V9 existe, é testado contra stand-ins e contra vetores gerados pelo próprio provider V9, e
falha fechado em todos os pontos de confiança. **Nada foi executado contra um banco PostgreSQL, contra o
OpenVINO real nesta árvore, em Linux, nem em vídeo real.** Por isso não há implantação.

*Atualização de 22/10/2026:* a paridade do detector em Linux foi medida em outra frente e **aceita pelo dono** (bloqueio 1 abaixo;
`docs/adr/ADR-161-v9-linux-parity-criterion.md`). As demais lacunas deste parágrafo seguem valendo.

## Decisão de proprietário e escopo

Aceite do proprietário (Brain #3677): rostos em primeiro plano e, em especial, o orador; 74,6% dos
rostos de referência nas imagens de desenvolvimento. Não é qualificação, não é confirmação independente,
não concede `faceSafety`. O produto responde "a área da legenda está livre?" em três estados, não
"todos os rostos foram achados?".

## O que foi construído (commits 1–6)

| Camada | Arquivos principais |
| --- | --- |
| Política fixada e versionada | `src/v2/domain/face-evidence-policy.ts` (`w62-v9-foreground-evidence/v1`) |
| Decodificador literal da saída V9 | `src/v2/domain/face-detector-output.ts` |
| Envelope v2 selado | `src/v2/domain/face-producer-envelope-v2.ts` |
| Registro de produtores aceitos | `src/v2/domain/face-producer-registry.ts` |
| Fluxo de evidência confiável | `src/v2/domain/face-evidence-stream.ts` (`collectFaceEvidenceStream`) |
| Primeiro plano e orador | `src/v2/domain/face-foreground-model.ts` (`deriveFaceForegroundModel`) |
| Área de legenda em 3 estados | `src/v2/domain/face-caption-clearance.ts` (`evaluateFaceCaptionClearance`) |
| Ponte, detector, inventário, analisador de vídeo | `src/v2/infrastructure/perception/` (`openvino_face0204_bridge.py`, `openvino-face0204-detector.ts`, `face-runtime-inventory.ts`, `ffmpeg-openvino-face-video-analyzer.ts`) |
| Worker de janela | `src/v2/application/run-face-window-worker.ts`, `ports/face-window-worker.ts` |
| Persistência | `prisma/v2/migrations/20261018120000_face_window_v9_profile`, `src/v2/infrastructure/prisma/face-window-envelope-repository.ts` |
| Admissão e rotas | `enqueue-face-window-run.ts`, `PrismaFaceWindowRequestContextRepository`, `/v1/projects/{projectId}/face-window-operations` |
| Contrato público | capabilities `apollo.projects.face-window-operations.create|read` 1.0.0; schemas `face-window-run-request`, `face-window-operation-created`, `face-window-operation-read` v1 (envelope `face-producer-envelope/v2`) |

O contrato do diagnóstico YuNet (`face-producer-operations`, envelope v1) **não mudou**: o perfil V9 é um
recurso novo. Os repositórios YuNet e V9 são isolados nos dois sentidos (perfil e versão de schema).

## Ponto de operação (política fixada, não é qualificação)

Origem de cada número em `parameterBasis` dentro da própria política: `owner-accepted-v9-literal`,
`development-analysis`, `coordinator-decision` ou `design-prior-unmeasured`.

- Coleta: toda detecção com score ≥ 0,20 é persistida; o subconjunto ≥ 0,50 reproduz a V9 literal.
- Evidência de primeiro plano e orador: score ≥ 0,50; primeiro plano = altura do rosto ≥ 10% da altura do quadro.
- Persistência da trilha: ≥ 50% das amostras analisadas da janela de 2 s para entrar, histerese de saída em 35%.
- Orador: maior rosto de primeiro plano persistente; troca só com 1,25× de área mantida por 1 s.
- Liberação da área de legenda: detecções ≥ 0,20, de qualquer tamanho; margem de dilatação de 35% do maior lado
  da caixa (mínimo 1,5% do quadro); lacuna máxima entre amostras de 0,5 s; retângulos fechados (tocar é ocupar).
- Precedência: evidência não autenticada perto da cue → `unknown`; sobreposição em evidência autenticada →
  `occupied`; cobertura incompleta → `unknown`; só então `free-certified`.
- Amostragem: 6 Hz, janela de no máximo 300 quadros e 60 amostras, um processo FFmpeg por janela.

Evidência de desenvolvimento: `tables.md` e `results.json` em `BASE/w62-v9-foreground-analysis-20261018/` (SHAs na política).
Análise pós-hoc, adaptativa, intervalos largos. Em imagens paradas: rostos ≥ 10% de altura 34/43 em 0,50;
bandas ocupadas falsamente livres 3/26 imagens em 0,50, 2/26 em 0,20, 1/26 em 0,10; falsa ocupação da banda
inferior 2/49 em 0,50 e 8/49 em 0,10; dilatação entre 10% e 20% não mudou nada; 0205 e a união não
acrescentam nada até 0,30.

## Falha fechada

- Plataforma sem recibo de paridade (hoje: tudo que não é `win32`) → `createFaceWindowWorker` recusa antes de reivindicar.
- Entrada fixada ausente (`APOLLO_V2_FACE_V9_*`), manifesto de runtime com hash diferente, arquivo editado
  ou arquivo extra no diretório de pacotes → recusa na partida e a cada operação.
- Modelo, ponte, interpretador, FFmpeg, FFprobe e licença são hasheados antes e depois de cada janela.
- A resposta da ponte é desconfiada: as caixas são recalculadas em TypeScript a partir da saída bruta de
  5600 bytes. Saída inválida no slot selecionado derruba o quadro (`unknown`), nunca vira "sem rosto".
- Publicação: o registro autentica o produtor, as saídas brutas reproduzem as amostras, e tudo é selado na
  mesma transação que conclui a operação (cerca de lease, direitos e versão corrente).
- Leitura: o veredito do registro é recalculado agora e devolvido ao lado do envelope
  (`producerAuthentication`); evidência não autenticada vira `unknown` no fluxo de evidência.
- Fora do escopo desta fatia (source com vários clips, taxa ≠ 1, fps do source diferente do da timeline): a admissão recusa
  (`PRECONDITION_REQUIRED`) e o worker recusa (`INVALID_ARGUMENT`). Sem envelope, a liberação da área de legenda fica
  `unknown` por cobertura incompleta. É uma lacuna declarada, não um caso tratado.

## O que foi verificado (e como)

Executado nesta árvore, sem banco, sem OpenVINO real:

- Testes unitários de domínio, ponte (6 testes Python, `python -I -S -B`), detector e analisador (via ponte e runner falsos),
  inventário, worker, persistência offline, admissão e composição (`tests/v2/face-*.test.mjs`, `openvino-face0204-detector.test.mjs`,
  `ffmpeg-openvino-face-video-analyzer.test.mjs`, `run-face-window-worker.test.mjs`).
- Igualdade entre linguagens: vetores gerados rodando o provider V9 e conferidos pelo decodificador TypeScript
  (`tests/fixtures/face0204-v9-provider-vectors.json`).
- Contrato público: baseline regenerado, só adições (2 capabilities, 3 schemas); schemas estritos com testes
  positivos e 12 mutações negativas; constantes do schema amarradas às constantes do domínio.
- Auditoria estática de binários (`ffmpeg-binary-resolution`): os dois pontos de `spawn` novos estão registrados.

## O que NÃO foi executado

1. **Suítes PostgreSQL - rodadas em 18/10/2026, com um limite.** Sob o lock global e o harness supervisionado
   (`BASE/run-local-pg-w62-v9.mjs`, cluster descartável na porta 55571, zero backends, cluster parado e porta livre no
   pós-voo), evidência `BASE/w62-pg-runs/w62-v9-pg-6d5d366e`: `migrate deploy` aplicou
   `20261018120000_face_window_v9_profile` (exit 0), `prisma-face-window.integration.mjs` 3/3, composição sob tsx 1/1 e,
   como regressão, `prisma-face-producer.integration.mjs` 5 passam + 1 pulado (o caso do YuNet real exige o still licenciado).
   **Limite:** a migração foi aplicada a um banco limpo; **não** foi exercitada sobre tabelas que já tenham linhas
   (`face_producer_operations`/`face_producer_envelopes` legadas). As colunas novas têm `DEFAULT` e as CHECKs aceitam o
   valor legado por construção, mas isso é raciocínio, não execução.
2. **Composição sob tsx.** `npm run test:integration:face-window-composition` passa localmente (e passou no harness acima), mas não é passo de CI.
3. **Runtime real.** O pipeline completo com OpenVINO real, FFmpeg real e vídeo real não foi executado nesta árvore.
4. **Paridade em Linux**: executada e aceita pelo dono em 22/10/2026 (abaixo); o worker agora parte em Linux só com os bytes do recibo.
5. **Medição em vídeo real** (abaixo).
6. Regressão completa (`node --test` inteiro) e CI integral.

## Bloqueios de implantação

1. **Execução supervisionada de paridade em Linux (obrigatória) — ACEITO pelo dono em 22/10/2026** (Brain #3803;
   recibo `docs/quality/w62-v9-linux-parity-receipt.json`; critério nomeado e limites em
   `docs/adr/ADR-161-v9-linux-parity-criterion.md`). Resultado nas 60 imagens, Windows × Linux Intel × Linux AMD EPYC 9555P
   (OpenVINO 2026.4.0): detecções com score >= 0,5 idênticas (V9 61/61, retail-0004 52/52), delta máximo de caixa/score
   3,6e-7 e 8,9e-7; tensores brutos byte-idênticos em apenas 1/60 (V9) e 53/60 (retail), dependentes da CPU. **O critério
   original (byte a byte) NÃO foi atendido**; o dono aceitou o critério `detections-identical-max-delta-1e-6`. O recibo vale
   só para o interpretador, o manifesto de runtime e a ponte nomeados nele (qualquer outro byte volta a recusar). A medição
   rodou a ponte do oráculo de pixels; o registro fixa a ponte do worker (no Windows ela reproduziu os tensores V9 do
   oráculo em 60/60, uma corrida). **Fechado em 23/10/2026:** a ponte do worker (`36be4b38…`) rodou as mesmas 60 imagens no
   droplet Linux AMD EPYC 9555P (ric1): 60/60 `observed`, 61 detecções com score >= 0,5 na mesma ordem, delta máximo
   8,94e-7 contra o oráculo Windows e 8,34e-7 contra o Linux Intel, e tensores V9 byte-idênticos em 60/60 contra o oráculo
   na mesma CPU. Os hashes calculados no droplet (interpretador `e50d468e…`, manifesto de runtime `5d5fbba5…` pelo hash
   canônico `faceRuntimeManifestSha256` sobre 2028 arquivos, ponte `36be4b38…`) batem com os pinos do recibo; a composição
   real de `createFaceWindowWorker` em Linux foi aceita, e com a ponte trocada recusou com `BRIDGE_PIN_MISMATCH`. Evidência
   fora do repositório: `Documents/Apollo/w61-70-20261008/do-test-env/v9-linux-parity-20261022/worker-bridge-rerun/`.
   Texto original do gate, mantido como histórico: rodas de
   produção em Linux fixadas por hash + manifesto de runtime; as 60 imagens de desenvolvimento passam pelo detector no runtime Linux e as saídas são
   comparadas byte a byte com os tensores da V9, **sem ajustar nenhum parâmetro**. O recibo dessa execução entra
   no registro (`ACCEPTED_FACE_PRODUCERS`) como uma nova plataforma; antes dele o worker recusava partir em Linux e um
   envelope Linux não era autenticado. A mesma execução conta quantos quadros caem na regra mais estrita desta
   implementação (linha inválida com score entre 0,20 e 0,50 derruba o quadro, a V9 literal a descartava).
2. **Execução supervisionada das suítes PostgreSQL** e da migração (item 1 acima).
3. **Medição em vídeo real.** Os 74,6% são de JPEG parado; o produto decodifica quadros de vídeo. A taxa real
   (talking head, agregação temporal) virá da jornada W70, reproduzível a partir da evidência persistida.
4. **Passos de CI** para as suítes novas (hoje declaradas como não executadas pelo CI em
   `tests/v2/mandatory-journey-ci-wiring.test.mjs`).

## Limites declarados

- Valores sem medição, marcados `design-prior-unmeasured` na política: janela de agregação, histerese de saída,
  mínimo de amostras, associação de trilhas, regra de troca de orador. Comportamento em janelas truncadas nas bordas
  é prior de projeto, não resultado.
- Quadros decodificados de vídeo diferem de JPEG parado; a diferença não está medida.
- Orador = proeminência visual, não detecção audiovisual de quem fala.
- `faceSafety` permanece `unknown`. Plano de âncoras v3 e snapshot v3 do Diretor ficam fora desta branch (W64/W65).

## Como a evidência é lida

`PrismaFaceWindowEnvelopeRepository.listWindows` devolve os envelopes verificados que se sobrepõem a um intervalo;
`collectFaceEvidenceStream` os junta (janelas conflitantes ou não autenticadas viram não confiáveis);
`deriveFaceForegroundModel` produz trilhas, primeiro plano e orador; `evaluateFaceCaptionClearance` responde
`free-certified`, `occupied` ou `unknown` para uma área de legenda. Tudo isso é derivado e reproduzível a partir
do envelope e das saídas brutas persistidas; nada derivado é gravado como verdade.

## Operação (para quando houver paridade)

Um processo roda um perfil: `APOLLO_V2_FACE_PROFILE=openvino-face0204-v9 node scripts/run-v2-face-producer-worker.mjs`
(padrão `yunet-v5-diagnostic`). Entradas fixadas: `APOLLO_V2_FACE_V9_PYTHON_BIN|PYTHON_SHA256|PYTHON_MODULE_DIR|
MODEL_XML|MODEL_BIN|BRIDGE_SCRIPT|BRIDGE_SHA256|RUNTIME_MANIFEST|RUNTIME_MANIFEST_SHA256|FFMPEG_BIN|FFMPEG_SHA256|
FFPROBE_BIN|FFPROBE_SHA256|MODEL_LICENSE|MODEL_LICENSE_SHA256`. O manifesto do runtime é gerado por
`node scripts/ops/build-face-runtime-manifest.mjs --root <site-packages> --out <manifest.json>`; gerá-lo é um
inventário, não uma aprovação.

Suítes não executadas pelo CI, citadas aqui por nome: `prisma-face-window.integration.mjs`,
`face-window-composition.integration.mjs`.
