# Spec 05 — Sincronização Multicâmera, Tela e React

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **PRD relacionado:** FR-034, FR-140–150

## 1. Objetivo

Construir um mapa confiável entre fontes gravadas no mesmo evento, mesmo com inícios, durações, relógios, frame rates, áudios e interrupções diferentes.

## 2. Non-goals

- Não igualar durações artificialmente.
- Não declarar sync exato sem evidência.
- Não usar filename/creation time como única prova.
- Não corrigir react não linear com playbackRate global.
- Não escolher ângulos editoriais nesta etapa.

## 3. Invariantes

1. Preservar PTS/timebase antes de normalizar.
2. SyncMap é source→session, nunca source→outro source encadeado.
3. Coverage ausente não é preenchida por stretch.
4. Confidence pertence a cada map segment.
5. PlaybackRate é aplicado apenas quando drift foi medido.
6. Scratch audio e final audio são papéis separados.
7. Manual anchor é evidência válida e auditável.
8. Fonte sem evidência comum exige `manualRequired`.

## 4. Modelo

```ts
interface CaptureSession {
  id: string
  referenceTrackId: string
  sessionFps: number
  trackIds: string[]
  protocolId?: string
  status: 'draft' | 'analyzing' | 'needs-input' | 'synced' | 'partial' | 'failed'
}

interface SourceTrack {
  id: string
  role: 'camera-main' | 'camera-alt' | 'screen' | 'phone' | 'reaction' | 'reference-video' | 'microphone' | 'master-audio'
  clipIds: string[]
  syncAudioPolicy: 'available' | 'none' | 'sync-only' | 'final-candidate'
}
```

## 5. Relógio de referência

Escolha por ordem:

1. timecode/shared recorder confiável;
2. master audio contínuo de maior coverage;
3. câmera principal contínua;
4. track escolhido pelo usuário;
5. timeline sintética cobrindo união dos tracks.

Critérios: continuity, timestamp quality, duration, gaps e papel final. Escolha fica persistida e pode ser alterada, causando recompilação dos maps.

## 6. Timebase e normalização

Para cada source:

- guardar stream timebase;
- extrair timestamp de frames-chave e amostras;
- detectar VFR e discontinuities;
- registrar start_time e duration sem tratá-los como verdade absoluta;
- criar SourceToNormalizedMap após transcode.

Normalização CFR deve manter mapa para PTS original. Tolerância do mapa: ≤ 1 frame da session timeline em samples validados.

## 7. SyncAnchor e map

```ts
interface SyncAnchor {
  id: string
  trackId: string
  sourceTimestampUs: number
  sessionTimestampUs: number
  method: 'timecode' | 'audio' | 'apollo-marker' | 'visual' | 'transcript' | 'manual'
  confidence: number
  evidenceRef: string
}

interface SyncMapSegment {
  sourceStartUs: number
  sourceEndUs: number
  sessionStartUs: number
  rate: number
  confidence: number
  anchorIds: string[]
}
```

Conversão para frames ocorre depois, usando sessionFps e arredondamento documentado.

## 8. Estratégia em cascata

| Método | Pré-condição | Precisão-alvo | Falha típica |
|---|---|---:|---|
| Shared timecode | clock comum | ≤1 frame | metadata removida |
| Audio fingerprint | evento acústico comum | ≤2 frames | fones/áudio independente |
| Apollo Marker | flash+chirp | ≤1–2 frames | chirp não capturado |
| Visual event | evento visto em ambas | ≤3 frames | ângulos sem evento comum |
| Transcript | fala correspondente | 3–10 frames | áudio diferente/ASR impreciso |
| Manual | usuário marca | depende do UI | anchor errado |

Precisão-alvo é critério inicial para 30fps e deve ser calibrada.

## 9. Correlação de áudio

Pipeline:

1. extrair mono PCM de baixa taxa para sync;
2. normalizar ganho sem destruir eventos;
3. gerar fingerprint/espectrogram features;
4. buscar offset em janelas;
5. validar pico versus segundo melhor pico;
6. repetir início/meio/fim;
7. estimar drift;
8. rejeitar falso match.

### 9.1 Confidence inicial

- Pico/segundo pico ≥ 1,5 e consistência entre janelas: high.
- 1,2–1,49 ou apenas uma janela: medium.
- <1,2: não aceitar automaticamente.

Valores devem ser calibrados com fixtures reais.

## 10. Offset e drift

Com dois ou mais anchors, ajustar modelo afim:

```text
sessionTime = sourceTime × rate + offset
```

- `offset`: alinhamento inicial.
- `rate`: diferença de clock.

Residual máximo para map linear high confidence: ≤2 frames em anchors de validação. Acima disso, tentar piecewise ou pedir anchors.

Não corrigir drift inferior a 1 frame por 10 minutos se a correção introduzir mais artefato que benefício; policy calibrável.

## 11. Piecewise maps

Criar novo segment quando:

- recorder parou/voltou;
- PTS discontinuity;
- arquivo split com gap/overlap;
- react pause/seek/rewind;
- residual do modelo linear excede threshold;
- usuário adiciona anchor incompatível com segment atual.

Segments não podem se sobrepor em source time. Session coverage pode sobrepor outros tracks normalmente.

## 12. TrackCoverage

```ts
interface TrackCoverage {
  trackId: string
  sessionRange: TimeRange
  sourceClipId: string
  syncMapSegmentId: string
  confidence: number
  availability: 'available' | 'gap' | 'corrupt' | 'unverified'
}
```

Director recebe availability por range; `unverified` não é usado em auto-switch.

## 13. Recorder splits

Detectar candidatos por metadata, proximidade temporal, codec/config, frames/áudio nas bordas. Nunca concatenar automaticamente se gap/overlap não for medido. Manter files originais e SourceTrack lógico.

## 14. Professor + tela

### 14.1 Hierarquia recomendada

1. mesma ferramenta/clock;
2. screen capture com microfone;
3. Apollo Sync Marker;
4. visual/transcript;
5. manual.

### 14.2 Capture Protocol obrigatório na UI

Exibir antes da gravação:

- iniciar ambas gravações;
- preservar scratch audio;
- emitir marker inicial/final;
- não pausar sem novo marker;
- enviar originais;
- informar fones/sem áudio ambiente.

## 15. Apollo Sync Marker

Um evento gera simultaneamente:

- flash/padrão frame-detectável;
- QR/session code;
- chirp de assinatura única;
- timestamp do browser/app;
- sequence number.

Screen grava o visual; câmera/mic grava chirp. Detector correlaciona ambos. Marker inicial resolve offset; final mede drift; após restart inicia novo piecewise segment.

Fallback: código falado. Deve registrar latency humana e confidence inferior; não prometer frame-accuracy.

## 16. React PlaybackMap

```ts
interface PlaybackMapSegment {
  reactionRange: TimeRange
  referenceRange?: TimeRange
  mode: 'playing' | 'paused' | 'rewind' | 'replay' | 'seek' | 'commentary-only'
  rate?: number
  confidence: number
}
```

Audio fingerprint do vídeo original dentro do react encontra ranges. Gaps no fingerprint viram pause/commentary; ordem regressiva indica rewind/replay. Não assumir que reference avança durante fala do reactor.

## 17. Manual sync UX contract

- players lado a lado;
- waveform/thumbs;
- escolher evento na referência e target;
- nudge por frame;
- preview simultâneo;
- adicionar segundo anchor;
- mostrar residual/drift recalculado;
- salvar/cancelar sem destruir auto anchors.

Anchor manual contraditório deve avisar impacto e permitir novo piecewise segment.

## 18. SyncDiagnostic

```ts
interface SyncDiagnostic {
  sessionId: string
  referenceTrackId: string
  globalConfidence: number
  tracks: TrackSyncDiagnostic[]
  warnings: DiagnosticWarning[]
  manualRequired: boolean
  generatedAt: string
}
```

Por track: methods, offset, rate/drift, coverage, gaps, residual, anchors e preview samples.

### 18.1 Status

- `synced-high`: residual dentro da precisão-alvo.
- `synced-medium`: editável, revisão recomendada.
- `partial`: alguns ranges/tracks sem sync.
- `needs-input`: anchors necessários.
- `failed`: source inválido.

## 19. Validação visual/labial

Top samples em início/meio/fim e após boundaries. Quando rosto+fala existem, estimar lip alignment como validator secundário; não usar para reescrever map high-confidence sem evidência adicional.

## 20. Direção multicâmera — contrato de saída

Sync engine fornece:

- sources disponíveis por frame;
- confidence;
- active speaker candidates;
- screen activity;
- technical quality;
- gaps.

Director escolhe ângulo em outra etapa. Range com confidence baixa não pode ser auto-selecionado sem warning/fallback.

## 21. Falhas e fallback

| Falha | Ação |
|---|---|
| sem sinal comum | manualRequired |
| pico ambíguo | tentar marker/visual/manual |
| drift não linear | piecewise/anchors adicionais |
| clip corrompido | gap; usar outras tracks |
| VFR irregular | timestamp map, não frame index |
| marker só visual | combinar timestamp/manual; confidence limitada |
| referência muda | recomputar maps e invalidar planos dependentes |
| residual alto | não marcar synced-high |

## 22. Observabilidade

- método por track;
- correlation peak ratios;
- anchors/residuals;
- drift ppm/rate;
- coverage/gaps;
- manual intervention rate;
- sync processing time;
- regressões por fixture;
- camera-switch issues no proxy.

## 23. Fixtures obrigatórias

- duas câmeras com mesmo áudio/offset;
- microfones com EQ/ruído diferentes;
- câmera iniciando tarde/terminando cedo;
- drift linear de relógio;
- stop/resume;
- VFR screen recording;
- marker visual+sonoro;
- professor com fones/código falado;
- react com pause/rewind;
- fontes sem sinal comum.

## 24. Cenários Given/When/Then

### MS-01 — Durações diferentes

**Given** A cobre 60min e B cobre 12–39min  
**When** sync conclui  
**Then** B possui somente coverage 12–39, sem stretch.

### MS-02 — Drift

**Given** anchors início/fim divergem progressivamente  
**When** fit afim residual ≤2 frames  
**Then** map usa rate corrigido e registra drift.

### MS-03 — Sem evidência

**Given** screen sem áudio, sem marker e câmera sem tela visível  
**When** auto-sync roda  
**Then** manualRequired=true; nenhum offset inventado.

### MS-04 — Marker

**Given** flash na screen e chirp na câmera  
**When** detector encontra sequence ID  
**Then** cria anchor comum com evidence refs.

### MS-05 — React pause

**Given** reactor pausa original por 20s  
**When** PlaybackMap é criado  
**Then** referenceRange fica parado/ausente enquanto reaction avança.

### MS-06 — Job após nova referência

**Given** usuário troca referenceTrack  
**When** maps antigos existem  
**Then** são invalidados/versionados e planos downstream ficam stale.

## 25. Critérios de aceite

1. Timebase original é preservado antes do transcode.
2. SyncMap source→session é independente de chain entre tracks.
3. Durações/gaps são representados sem stretch.
4. Correlação ambígua não vira auto-sync.
5. Offset/drift possuem residual e confidence.
6. Piecewise cobre stop/rewind/VFR discontinuity.
7. Apollo Marker resolve professor+tela sem shared audio.
8. Manual anchors são auditáveis e reversíveis.
9. SyncDiagnostic explica método, coverage e warnings.
10. Fixtures medem precisão em frames.
11. Active source nunca usa range unavailable.
12. Mudar referência invalida downstream corretamente.

## 26. Questões para ADR/calibração

- Biblioteca de fingerprint/cross-correlation.
- Session time unit e precisão interna.
- Thresholds por fps/duração.
- Implementação do Marker browser versus companion app.
- Lip-sync validator.
- Tratamento de drift no áudio final sem alterar pitch.


---

## 27. Estado de implementação — Wave 18 (F4.002–F4.008)

Implementado localmente em 2026-09-03. Deploy e aceite pendentes.

### 27.1 O que foi construído

| Seção da spec | Módulo | Evidência |
|---|---|---|
| §5 Relógio de referência | `src/v2/domain/session-clock.ts` | T-FR-141, 11 casos |
| §6 Timebase e normalização | `src/v2/domain/session-time.ts` | 13 casos |
| §7 SyncAnchor e map | `src/v2/domain/sync-evidence.ts` | T-FR-142, 13 casos |
| §8 Estratégia em cascata | `src/v2/domain/sync-evidence.ts` | T-FR-142 |
| §10 Offset e drift | `src/v2/domain/clock-drift.ts` | T-FR-144, 12 casos |
| §11 Piecewise maps | `src/v2/domain/piecewise-clock-map.ts` | T-FR-145, 14 casos |
| §12 TrackCoverage | `src/v2/domain/track-coverage.ts` | T-FR-143, 14 casos |
| §13 Recorder splits | `capture-session.ts` + piecewise | E2E heterogêneo |
| §4 Modelo | `src/v2/domain/capture-session.ts` | T-FR-140, 8 casos |

Persistência em treze tabelas com `CHECK` e `EXCLUDE` que carregam as
invariantes; API `/v1` com doze capabilities e rotas executáveis; worker durável
com lease, heartbeat e fencing; página operável em `/capture-sessions`.

### 27.2 Decisões que a spec não previa

**Sessão é cadeia imutável mais ponteiro.** A spec descrevia o modelo sem dizer
como versioná-lo. Cada operação devolve versão+1 carregando o hash da anterior,
e o ponteiro `capture_session_heads` diz qual é a corrente. Colapsar os dois
numa linha atualizável significaria que adicionar uma faixa reescreve
silenciosamente o que a versão anterior dizia — que é exatamente a pergunta que
um editor faz quando um corte deixa de bater com o material.

**Ticks atravessam a fronteira pública como string decimal.** Número JSON é
`double` IEEE 754 em todo parser corrente, então um tick de 64 bits chegaria ao
cliente já arredondado, sem erro e sem como perceber. Taxas atravessam como
`"num/den"` pelo mesmo motivo invertido: 30000/1001 não tem forma decimal
alguma.

**A run de sincronização é fenced, não apenas leased.** Um lease é um timeout, e
um processo pausado não pode ser avisado de que foi pausado. O token de fencing
cresce estritamente por sessão e só o mais alto pode liquidar.

### 27.3 O que continua aberto

- §9 correlação de áudio: a cascata consome sinais por uma porta; nenhum
  fingerprinter de produção foi escrito.
- §14 a §16, §19 a §24: Capture Protocol, Apollo Marker, react PlaybackMap,
  direção multicam e color match seguem fora de escopo (F4.009 a F4.016).
- §26: a biblioteca de fingerprint, os thresholds por fps/duração e o tratamento
  de drift no áudio final sem alterar pitch continuam sem calibração contra
  material real.

### 27.4 Não medido

A migração nunca foi aplicada contra um PostgreSQL: não há instância nesta
máquina. `btree_gist`, as constraints `EXCLUDE` e o E2E de browser são medidos
apenas no CI.

## 28. Estado de implementação — Wave 19 (F4.009–F4.011)

Implementado localmente em 2026-09-04. Deploy e aceite pendentes.

### 28.1 O que foi construído

| Seção da spec | Módulo | Evidência |
|---|---|---|
| §14 Professor + tela, §15 demais cenários | `src/v2/domain/capture-protocol-catalog.ts` | T-FR-147, 12 casos |
| Protocolo versionado e endereçado por conteúdo | `src/v2/domain/capture-protocol.ts` | T-FR-147 |
| Conformidade derivada da sessão | `src/v2/domain/capture-protocol-evaluation.ts` | T-FR-147 |
| §16 Apollo Sync Marker | `src/v2/domain/sync-marker.ts` | T-FR-148, 14 casos |
| Marcador como mídia verificável | `src/v2/infrastructure/media/ffmpeg-sync-marker-renderer.ts` | 3 casos com ffprobe |
| Detectores independentes e fusão | `src/v2/domain/sync-marker-detection.ts` | T-FR-148 |
| Detecção sobre mídia real | `src/v2/infrastructure/media/ffmpeg-marker-detectors.ts` | 9 fixtures geradas |
| §18 SyncDiagnostic | `src/v2/domain/sync-diagnostic.ts` | T-FR-149, 13 casos |
| §17 Contrato de UX de sync manual | `src/v2/domain/sync-diagnostic-anchors.ts` + `/sync-diagnostic` | E2E de jornada |

Persistência em sete tabelas; API `/v1` com catorze capabilities e dez rotas;
duas páginas operáveis (`/capture-protocols` antes de gravar, `/sync-diagnostic`
depois).

### 28.2 Decisões que a spec não previa

**Exigência obrigatória precisa nomear o que se perde.** A spec listava
requisitos; o construtor recusa um item `required` que não nomeie nenhuma
capacidade de sincronização perdida sem ele. Um requisito que não custa nada
quando pulado não é obrigatório — é preferência com o rótulo errado, e um
operador atrasado acerta ao pular.

**Concordância entre canais não identifica o marcador.** Ver
[ADR-151](../adr/ADR-151-marker-identity-requires-the-code.md). Todo marcador
de uma sessão alterna igual e varre o mesmo chirp; só o código visual carrega
identidade.

**Cobertura não medida é `null`, nunca zero.** Zero afirma "nada desta faixa é
aproveitável" sobre uma medição que ninguém fez, e o bloqueio de corte
automático se apoia nesse número. `null` não sustenta a nota máxima e também não
é `partial`: cai em `synced-medium`, que é exatamente "editável, convém
conferir".

**Avaliação e diagnóstico nomeiam a versão da sessão.** Ambos são derivações de
uma CaptureSession, e a Wave 18 já decidiu que derivação nomeia versão+hash.
Sem isso, uma faixa adicionada um segundo antes muda silenciosamente a resposta
sobre a qual o operador está prestes a agir.

**A chave de idempotência do marcador é ligada à credencial inteira.** Gerar
marcador não tem chave natural: repetir renderiza um segundo clipe e queima uma
segunda sequência, e depois "qual marcador a câmera viu" passa a ter duas
respostas. O id do marcador é derivado de workspace, cliente, credencial, tipo
de autenticação e usuário delegado — duas credenciais do mesmo cliente são dois
chamadores.

**O arquivo procurado vem da posição do marcador — pelo ordinal, não pelo
`splitReason`.** Um marcador emitido após reinício está no arquivo de reinício e
em nenhum outro. Procurar no primeiro reportaria ausência do que foi gravado;
procurar em todos deixaria um marcador de início ser creditado a um reinício.

O sinal certo é o ordinal. A Wave 18 recarimba **a primeira** parte como
`recorder-restart` no instante em que uma segunda chega — de propósito, porque
uma primeira parte que continuasse dizendo `single-file` estaria mentindo. Ou
seja: o `splitReason` diz que a faixa está partida, nunca qual arquivo veio
depois da quebra. Ler o campo como se dissesse a segunda coisa fazia todo
marcador de reinício ser procurado no arquivo anterior ao reinício, onde ele
nunca poderia estar.

**"Cada câmera" quer dizer cada uma.** A checagem
`track-carries-sync-audio` aceitava uma faixa do papel com áudio utilizável e
declarava o requisito cumprido. O requisito diz "cada câmera grava o próprio
áudio de referência", e uma câmera que jogou o áudio fora não pode ser alinhada
por impressão digital, independentemente do que a câmera ao lado fez. A leitura
permissiva reportava `audio-fingerprint` intacta numa sessão que já a tinha
perdido em um gravador — o teto mentindo na direção mais cara.

**Mídia materializada é devolvida no `finally`.** O resolvedor chamava
`materialize` e nunca `cleanup`. No driver S3 isso baixa a gravação inteira para
um diretório por operação, então cada detecção deixava uma cópia completa em
disco — uma varredura de seis faixas vaza seis gravações por passada. O driver
local aponta para a raiz de artefatos e não copia nada, que é exatamente por que
o esquecimento era invisível em desenvolvimento. `resolve` agora devolve
`{ path, release }` e todo chamador libera no `finally`.

### 28.3 O que continua aberto

- O canal de áudio não carrega identidade. Enquanto `DEFAULT_MARKER_AUDIO` for
  fixo, o teto de robustez do marcador é o teto de legibilidade do código.
- O código só é lido em escala nativa (recorte central de `codeSizePx`). Filmado
  maior ou menor, o flash aparece e o código some.
- A varredura de detecção é retomável e observável, mas **não é fenced**. O
  progresso é a própria tabela de detecções, então uma passada que morre
  recomeça exatamente onde parou; dois trabalhadores na mesma sessão duplicam
  decodificação e convergem em linhas idênticas, porque cada par é chaveado por
  marcador e faixa. Isso custa CPU, não correção — diferente da run de
  sincronização da Wave 18, onde liquidar um resultado obsoleto atribuiria um
  mapa à versão errada e por isso exige token de fencing.
- `spoken-code` existe como tipo e carrega um piso de erro de 120 ms; nenhum
  reconhecedor de fala foi escrito, e a spec é explícita em não prometer
  precisão de quadro para ele.

### 28.4 Não medido

O round trip contra PostgreSQL e a jornada de navegador não foram executados
nesta máquina: não há runtime de contêiner aqui. Os testes existem, estão
ligados ao job de CI que tem banco e build de produção, e são medidos lá — não
aqui.

Dois erros de método registrados porque a forma se repete.

O primeiro: os módulos de mídia da Wave 19 resolviam `ffprobe` pelo nome nu.
`ffmpeg-static` empacota só o ffmpeg; o ffprobe existe no meu PATH e não no
runner. O repositório já depende de `ffprobe-static` e todo outro módulo de
mídia resolve por ele — eu adotei a conveniência da minha máquina em vez do
padrão que já existia, e o suite passava aqui e falhava em qualquer outro
lugar. Os testes também passavam `ffprobePath` explícito, o que forçava o valor
quebrado; agora deixam o módulo resolver, como a produção faz.

O segundo: dois suites de mídia estavam
registrados no `package.json` sob `tsx`, que transpila os módulos `.ts` para
CJS e torna os exports nomeados invisíveis ao importador ESM. Toda invocação
morria em `does not provide an export named FfmpegSyncMarkerRenderer`. Eu vinha
rodando os arquivos direto com `node` e lendo isso como "o suite passa" —
verificando o arquivo, não o comando. Ambos rodam com `node` agora e estão no
CI.
