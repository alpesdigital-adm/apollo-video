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

**Corrigido na Wave 20 (F4.012):** o worker existia como função e nada o
chamava — `POST .../sync-runs` enfileirava uma linha que nenhum processo
consumia. A Wave 20 entregou o driver (`scripts/run-v2-capture-sync-worker.mjs`,
`npm run worker:v2:capture-sync`, com `--once` para CI), a primeira
implementação de `SyncSignalSource`
(`infrastructure/media/ffmpeg-audio-sync-signal-source.ts`) e o produtor de
`TrackCoverage` dentro do worker. O fallback de frame rate `30000/1001` saiu: a
taxa vem do relógio persistido ou do timebase da track de referência, e sem
nenhum dos dois o run é liquidado como falho com o motivo nomeado.

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

**O lease tem que ser maior que a medição.** Uma correlação de áudio é uma
chamada síncrona: medido nesta máquina com os argumentos que o adaptador usa
(2 kHz, janelas de 2 s, busca exaustiva), um par (parte candidata × parte de
referência) custa 160 ms (N=3, sd 12 ms) para 40 s de material, 9,1 s (N=3,
sd 1,6 s) para 300 s e 71 s (N=1, 345 MB de RSS) no teto de análise de 1800 s do
próprio adaptador. Com o lease de 60 s que o worker trazia, qualquer sessão além
de cerca de um minuto de áudio era retomada no meio da medição e falhava de vez
depois de três tentativas. O lease padrão é de cinco minutos, o `SyncSignalSource`
recebe um `heartbeat` que o adaptador aguarda entre decodificações e entre pares
— nenhum temporizador serviria, porque a busca não devolve o event loop — e a
fábrica lê `APOLLO_V2_CAPTURE_SYNC_LEASE_MS ?? APOLLO_V2_WORKER_LEASE_MS`.

**Uma peça do mapa é um trecho de ticks de origem que uma lei descreve, não um
arquivo.** Dois arquivos que se encostam exatamente e concordam no deslocamento
são UMA peça: rotular essa junção como `file-split` — causa descontínua — fazia
`createPiecewiseClockMap` recusar a divisão de 4 GB mais comum que existe, e a
`DomainError` escapava do worker deixando a run reivindicada e nunca liquidada.
Duas partes que medem deslocamentos diferentes viram duas peças, abertas por
`residual-exceeded`, cada uma com o deslocamento que a sua própria parte mediu.

**Arquivo ausente é fato da sessão, não falha da run.** Um artefato que sumiu ou
cujos bytes não são mais os que a parte declara degrada AQUELA trilha para
`insufficient-evidence` e a passagem continua; um codec que não abre continua
falhando a run inteira. Uma câmera sem cartão copiado não pode bloquear a
sincronização das outras cinco.

### 27.3 O que continua aberto

- §9 correlação de áudio: **entregue na Wave 20**. O adaptador decodifica as
  duas trilhas, correlaciona janelas com `correlateAudioWindows` (F4.015) e
  emite `SyncSignalObservation`; âncoras manuais do diagnóstico e marcadores
  confirmados entram pela mesma porta. Medido sobre fixture gerada: erro de lag
  de 0, 0, +18 e 0 ticks de 90 kHz em quatro atrasos (o único não nulo é o
  atraso deliberadamente fora da grade de correlação).
- §14 a §18 saíram do escopo da Wave 18 e foram entregues depois: Capture
  Protocol, Apollo Sync Marker, contrato de sync manual e SyncDiagnostic na
  Wave 19 (§28); react PlaybackMap, direção multicâmera, match de cor, crítico
  de cor e o gate da fase na Wave 20 (§29 a §34). Este item dizia
  "F4.009 a F4.016 seguem fora de escopo" e ficou falso no momento em que a
  §28 foi escrita logo abaixo dele.
- §26: a escolha de biblioteca de fingerprint está fechada — não há biblioteca
  externa; a correlação é `correlateAudioWindows`, escrita neste repositório
  (`src/v2/infrastructure/media/ffmpeg-playback-fingerprint.ts:436`), e os seus
  limiares de admissão são constantes exportadas (§32.2). Os thresholds por
  fps/duração e o tratamento de drift no áudio final sem alterar pitch
  continuam sem calibração contra material real.

O que a Wave 20 deixou aberto, medido e não estimado:

- **Drift não é ajustado.** `fitClockDrift` e a tabela `capture_drift_fits`
  continuam sem escritor: não existe função de hash canônico para um
  `ClockDriftFit`, e o repositório teria que inventar a serialização e a tabela
  filha de âncoras. O que a peça do mapa carrega hoje é o resíduo que o sinal
  eleito mediu para AQUELA peça, mais o tique de arredondamento que
  `createSourceToSessionMapping` sempre soma — um limite do deslocamento, não de
  uma taxa. O diagnóstico segue relatando `driftPpm: null`, que é "não medido",
  não zero.
- **Marcador confirmado não é prova admissível.** A cascata exige evidência de
  ambiguidade de todo método que localiza por busca, e `MarkerDetection` guarda
  só os ids das observações: o pico e o segundo pico que a fusão mediu não
  sobrevivem no agregado. As observações de marcador são emitidas e descartadas
  com `ambiguity-evidence-missing`, registrado no record.
- **`SessionClock` continua sem escritor.** O worker resolve a taxa de quadros,
  usa, e não persiste.

### 27.4 Não medido

A migração nunca foi aplicada contra um PostgreSQL: não há instância nesta
máquina. `btree_gist`, as constraints `EXCLUDE` e o E2E de browser são medidos
apenas no CI.

## 28. Estado de implementação — Wave 19 (F4.009–F4.011)

Implementado localmente em 2026-09-04. Deploy e aceite pendentes.

### 28.1 O que foi construído

| Seção da spec | Módulo | Evidência |
|---|---|---|
| §14 Professor + tela (os demais cenários não têm seção própria) | `src/v2/domain/capture-protocol-catalog.ts` | T-FR-147, 12 casos |
| Protocolo versionado e endereçado por conteúdo | `src/v2/domain/capture-protocol.ts` | T-FR-147 |
| Conformidade derivada da sessão | `src/v2/domain/capture-protocol-evaluation.ts` | T-FR-147 |
| §15 Apollo Sync Marker | `src/v2/domain/sync-marker.ts` | T-FR-148, 14 casos |
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

**Ticks são serializados antes de entrar no hash — e antes de entrar no banco.** Buracos de cobertura são
intervalos de tick, e tick é `bigint`; o hasher canônico recusa `bigint` de
propósito, porque não existe uma renderização óbvia. O resultado é que um
diagnóstico **com** buracos não podia sequer ser construído — exatamente a
sessão que vale a pena diagnosticar. Todo teste anterior passava `gaps: []`, e
por isso nada pegou. Serializados como a Wave 18 já serializa qualquer tick que
entra em hash, e o teste de regressão confirma que dois buracos diferentes
continuam produzindo digests diferentes.

O mesmo defeito existia uma camada abaixo: o repositório escrevia
`tracksJson` com `JSON.stringify`, que recusa `bigint` do mesmo jeito. Agora usa
o codec com tag `{"$tick": "…"}` que a Wave 18 já tinha para exatamente isso, e
o teste verifica o que importa — não que os bytes voltem, mas que o agregado
reconstruído a partir deles ainda confira contra o hash guardado ao lado.

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

## 29. Direção multicâmera (F4.012)

Implementa §20. `src/v2/domain/multicam-evidence.ts` guarda o que foi observado;
`multicam-direction.ts` decide; `camera-identity.ts` dá a chave que cor e render
usam para a mesma câmera. Todos os valores abaixo são as constantes exportadas
desses módulos, não uma paráfrase delas.

### 29.1 Evidência

`MULTICAM_EVIDENCE_KINDS` tem oito espécies: `active-speaker`,
`concurrent-speech`, `silence`, `reaction`, `demonstration`, `screen-activity`,
`technical-quality`, `attention`. Cada observação diz de que faixa fala, em que
intervalo semiaberto de ticks da sessão, com que confiança, e como veio a ser
acreditada — `EVIDENCE_EVALUATOR_KINDS` é `measured | controlled | declared`.
`declared` é frase humana carregada com rótulo; nunca vira medição.

Três consequências que o tipo impõe:

- `active-speaker` carrega `speakerKey` (um cluster de diarização) e
  `identityResolved: false`, literal. Um cluster não é uma pessoa.
- `concurrent-speech.speakerCount`, `silence.levelDbfs` e as três dimensões de
  `technical-quality` são anuláveis: não medido é `null`.
- `reaction.intensityBps`, `screen-activity.activityBps` e
  `attention.gazeOnCameraBps` são `PositiveBps` — basis points em `(0, 10000]`.
  Zero não é valor; é ausência de observação, e a observação não é emitida.

`SCREEN_ACTIVITY_SATURATION_BPS = 400` é o ponto de saturação da atividade de
tela. A régua é física — diferença absoluta média de luma entre quadros
consecutivos sobre 255 — e foi medida com a passagem de produção sobre fontes
geradas (`tests/v2/multicam-visual-evidence.integration.mjs`, uma execução por
fonte, 240 quadros cada): campo de cor estático 0 bps, slideshow trocando a cada
dois segundos 4 bps, padrão em movimento 103 bps, zoom de mandelbrot 137 bps,
ruído de quadro inteiro 3151 bps.

### 29.2 Candidatos

Um candidato é derivado por faixa e por janela. `ANGLE_CONTEXTS` é
`speaker | reaction | screen | wide | reference-video`; `VIDEO_ANGLE_ROLES`
limita ângulo a `camera-main`, `camera-alt`, `screen`, `phone`, `reaction` e
`reference-video` — papel só de áudio nunca é ângulo.

`ANGLE_REJECTIONS` são as quinze razões pelas quais um candidato não é elegível:

| Razão | O que ela diz |
|---|---|
| `not-a-video-source` | o papel da faixa não produz imagem |
| `coverage-missing` | não há `TrackCoverage` para essa faixa |
| `coverage-gap` | o gravador não gravou ali |
| `coverage-unverified` | ninguém verificou aquele trecho |
| `coverage-corrupt` | os bytes daquele trecho não abrem |
| `coverage-out-of-bounds` | a janela cai fora da cobertura medida |
| `coverage-below-floor` | a confiança da cobertura está abaixo do piso de corte automático |
| `sync-map-missing` | a fonte não tem mapa de relógio |
| `sync-uncovered` | a janela não cai em nenhuma peça do mapa |
| `sync-missing` | a faixa não aparece no diagnóstico |
| `sync-below-threshold` | o diagnóstico da faixa não sustenta corte automático |
| `protocol-ceiling` | o teto do protocolo é `manual-anchors-required` ou `not-synchronizable` |
| `quality-below-floor` | qualidade técnica **medida** abaixo de `qualityFloorBps` |
| `excluded-from-final-mix` | (áudio) a faixa está fora do mix final |
| `audio-not-final-candidate` | (áudio) `syncAudioPolicy` é `none` ou `sync-only` |

Duas leituras que a lista torna explícitas. `quality-below-floor` exige
qualidade medida: qualidade não medida não rejeita ninguém — só qualidade ruim
rejeita. E o piso de cobertura é o da Wave 18 (`assertCoverageSelectable` com
`purpose: 'auto-edit'`), não um segundo piso escrito aqui.

O score tem nove parcelas nomeadas (`ANGLE_SCORE_COMPONENT_NAMES`): `baseline`,
`speaker`, `demonstration`, `reaction`, `quality`, `continuity`,
`redundancyPenalty`, `protectedBonus`, `formatPenalty`. Cada parcela carrega as
suas `evidenceRefs`; a persistência guarda uma linha por parcela.

### 29.3 Regras e política

`DIRECTION_RULES` são as nove regras que podem decidir uma janela:
`demonstration-prefers-screen`, `speech-prefers-active-speaker`,
`reaction-cutaway`, `cutaway-return`, `redundant-angles-hold`,
`minimum-shot-hold`, `jump-cut-avoided`, `protected-selection`,
`conservative-hold`. Toda decisão registra qual delas decidiu e por quê, em
texto.

`DIRECTION_WARNINGS` são os nove avisos: `jump-cut-unavoidable`,
`protected-selection-ineligible`, `protected-selection-unknown-track`,
`no-eligible-candidate`, `session-not-auto-editable`, `ambiguous-active-speaker`,
`active-speaker-unmapped`, `minimum-shot-violated`, `audio-master-unavailable`.

`DEFAULT_DIRECTION_POLICY`, calibração `multicam-direction-2026-09-v2`:

| Campo | Valor |
|---|---:|
| `minimumShotMs` | 1200 |
| `maxCutawayMs` | 4000 |
| `jumpCutSameAngleMs` | 2000 |
| `redundancyThreshold` | 0,15 |
| `ambiguityMargin` | 0,1 |
| `rhythm.targetShotMs` / `varianceMs` | 8000 / 4000 |
| `conservativeHoldConfidence` | 0,65 |
| `protectedSelectionConfidence` | 0,9 |
| `qualityFloorBps` | 3000 |
| `reactionIntensityFloorBps` | 5000 |
| `weights` | speaker 1; demonstration 1,2; reaction 0,9; quality 0,25; continuity 0,1; protectedBonus 2; redundancyPenalty 0,15 |
| `contextBaseline` | speaker 0,3; wide 0,25; reference-video 0,3; screen 0; reaction 0 |
| `formatContextPenalties` | `9:16` → wide × 0,5; `1:1` → wide × 0,75 |

`resolveDirectionPolicy` converte cada duração para ticks da sessão uma vez, com
arredondamento único, e recusa uma política cujo `maxCutawayMs` ou
`jumpCutSameAngleMs` seja menor que `minimumShotMs`. Nenhum milissegundo solto
atravessa o algoritmo.

As bandas de confiança são as da spec 01 §20:
`DIRECTION_CONFIDENCE_BAND_FLOORS` = high 0,85, medium 0,65, low 0,4; abaixo
disso, `insufficient`.

### 29.4 O que nunca é auto-selecionado

- Qualquer candidato com pelo menos uma razão de `ANGLE_REJECTIONS` não entra na
  disputa. Ele continua **guardado** na decisão: `shot-decision/v2` faz hash de
  `evaluated`, isto é, de todos os ângulos pesados, com as suas rejeições, e não
  só do escolhido.
- Uma janela em que nenhuma faixa é elegível não recebe ângulo nenhum. Ela vira
  um intervalo de `uncovered`, com o aviso `no-eligible-candidate` que nomeia
  cada faixa e a sua rejeição, e a direção fica com `manualReviewRequired`. A
  compilação recusa transformar essa direção em clipes.
- Uma seleção protegida (`ProtectedSelection`) é uma atestação humana, não uma
  medição: elegível, ela vence e a decisão sai com
  `protectedSelectionConfidence`; inelegível, a janela é dirigida normalmente e
  o aviso `protected-selection-ineligible` nomeia as rejeições que a impediram.
  Ela nunca é substituída em silêncio.
- Dois candidatos com evidência a menos de `ambiguityMargin` um do outro não são
  ordenados: a direção segura o ângulo corrente e emite
  `ambiguous-active-speaker`. Fala simultânea **medida** dobra a margem.
- O chamador não fornece nada disso. Um pedido que traga score, elegibilidade,
  medição, aprovação ou `manualReviewRequired` é recusado pelo nome
  (`DIRECTION_CALLER_SUPPLIED_DERIVATION`), não ignorado.

### 29.5 O que a direção entrega

`multicam-direction/v2` é uma cadeia versionada por sessão, com hash canônico
que dobra o `decisionHash` de cada plano. Um plano cita no máximo
`SHOT_EVIDENCE_REF_CAP = 32` referências de evidência — o teto que
`createDecisionConfidence` já impunha a uma decisão de Director — e as duas
referências de porteiro (o diagnóstico de sync e a cobertura) são **reservadas**
antes de as observações preencherem o resto. Ordenar o conjunto inteiro e cortar
nos 32 primeiros descartava exatamente essas duas, porque `observation:` ordena
antes de `sync-diagnostic:` e `track-coverage:`. O número de referências
descartadas é gravado, para que uma lista cortada não seja indistinguível de uma
completa; a constraint `multicam_shot_decisions_evidence_check` recusa uma linha
que diga ter descartado alguma coisa sem ter chegado ao teto.

O comando é `direct-multicam-session`, registrado em `edit-command-registry.ts`
com `renderPolicy: 'deferred'`, `impactSchema: 'multicam-direction-impact/v1'` e
`deferralReason: 'director-run'`: um plano vira clipe quando um DirectorRun o
compila, e não quando o comando é aceito.

Um ângulo **é** um clipe. A compilação (`multicam-shot-compilation/v1`) resolve
cada plano para o intervalo de origem da faixa escolhida, monta
`EditorialCutClip` e recusa cadências de origem que o plano não possa cortar —
medido em `tests/v2/multicam-direction-render.integration.mjs`: com câmera A a
30/1 e câmera B a 25/1 num plano de 30/1, a compilação recusa com as taxas que o
`ffprobe` leu. Na mesma suíte, uma direção de duas câmeras rendeu 2 clipes sobre
3 fontes, 300 quadros, 10,000 s, h264/aac, e a inspeção de pixel confirmou a
troca de ângulo: `shot-0001@2,50s` vermelho, `shot-0002@7,50s` azul.

## 30. Match de cor multicâmera (F4.013)

Implementa FR-183. A spec 05 não tinha seção de cor; esta e a §31 são a seção
que faltava.

### 30.1 Medição

`camera-color-measurement/v1` (`src/v2/domain/color-measurement.ts`) mede um
intervalo de uma câmera. `COLOR_MEASUREMENT_DIMENSIONS` são oito, cada uma com
unidade fixa em `COLOR_MEASUREMENT_UNITS`:

| Dimensão | Unidade | O que é |
|---|---|---|
| `whiteBalance` | `ratio` | média do canal azul sobre a do vermelho; > 1 puxa azul |
| `exposure` | `normalized-luma` | luma BT.709 média sobre RGB decodificado, 0–1 |
| `contrast` | `normalized-luma` | desvio-padrão da luma |
| `blacks` | `ratio` | fração de pixels no piso de esmagamento |
| `highlights` | `ratio` | fração de pixels no teto de clipping |
| `saturation` | `normalized-chroma` | magnitude média de croma Cb/Cr |
| `tonalResponse` | `normalized-luma` | luma mediana, com P1…P99 como componentes |
| `skin` | `degrees` | ângulo de matiz do croma médio da banda de pele |

`COLOR_MEASUREMENT_STATUSES` é `measured | not-applicable | unavailable`, e uma
dimensão não medida tem de dizer o motivo. `COLOR_MEASUREMENT_MINIMUM_FRAMES = 3`:
abaixo de três quadros decodificados o intervalo não foi medido, digam os
números o que disserem — um quadro é um still, não uma estatística.

`COLOR_MEASUREMENT_COMPARABILITY_DIMENSIONS` são as quatro que um match precisa
ler como `measured` para comparar duas câmeras: `whiteBalance`, `exposure`,
`contrast`, `saturation`. Pele e resposta tonal informam; não sustentam o match.

Cada medição carrega o que o `ffprobe` disse dos bytes medidos — metadados de
cor, pixel format e `HDR_MODES` (`sdr | hlg | pq`) — e o intervalo de quadros de
origem que foi lido.

### 30.2 Ordem

O match é um estágio do `ColorPlan` já existente: `MATCH_PIPELINE_STAGE = 'match'`,
dentro de `COLOR_TRANSFORM_ORDER = ['technical', 'match', 'creative-lut', 'output']`.
A ordem não é uma convenção deste módulo — `createColorPlan` **recusa** uma
camada que declare a LUT criativa antes do match, com `COLOR_STAGE_VIOLATION`.
Igualar câmeras depois de graduar seria graduar o grau.

**Isto mudou na Wave 20, e o que havia antes era pior do que "sem regra".** Até
o commit `e1d5dec1`, a camada fora de ordem era **aceita**. `resolveColorPlan`
indexa os estágios por tipo (`color-and-export.ts:550-552`), então uma camada
declarada `[technical, creative-lut, match, output]` passava na construção, era
reordenada na leitura e renderizada numa ordem que o plano guardado não
descrevia: a declaração e o pipeline divergiam, e nada recusava. A guarda
`assertMatchStagePosition` existia, mas o único chamador de produção montava
camadas de um transform só, onde ela nunca pode falhar. Hoje ela roda dentro de
`normalizeLayer` (`color-and-export.ts:407-424`), que é por onde passa **toda**
camada de todo `ColorPlan`: a global e cada override de source, câmera e
segmento. A recusa carrega `{ position, after }`.

**O que isso faz com quem chama.** Um corpo que declare a LUT criativa antes do
match e que antes respondia 200 hoje responde **422 `COLOR_STAGE_VIOLATION`**,
categoria `policy`, `retryable: false` (`PUBLIC_ERROR_CATALOG`, lido em
2026-09-06). Vale para `POST /v1/projects/{projectId}/color-pipeline-compilations`
— `createColorPipelineCompilation` chama `resolveColorPlan`, que começa por
`createColorPlan` (`color-and-export.ts:524`) — e para
`POST /v1/projects/{projectId}/color-plan`, que chega ao mesmo construtor por
`createProjectColorPlan` (`application/project-color-plans.ts:159`,
`domain/project-color-plan.ts:54`). A rota de compilação tem asserção de
jornada: `E2E-F4.012` em `podcast-multicam-journey.e2e.mjs:1220-1245` e em
`teacher-screen-journey.e2e.mjs:794-821` conferem o código, a categoria e o
`retryable` do envelope. Essas duas jornadas **não** foram executadas nesta
máquina (§34.5); rodam no CI. Pela rota de ColorPlan a recusa é leitura de
código, não medição.

**E um plano já guardado na ordem antiga deixa de reidratar.** A leitura repassa
o plano pelo mesmo construtor: `parseProjectColorPlan`
(`project-color-plan.ts:74-101`) reconstrói o agregado com
`createProjectColorPlan`, então a guarda dispara também na leitura. Não há
migração de dados para isso, e este documento não afirma que exista. Nenhuma
linha assim existe em fixture ou seed deste repositório — se alguma existir num
ambiente implantado, ela para de ser legível, e ninguém mediu isso porque não há
ambiente implantado.

O provedor é `apollo-match`, em duas versões declaradas em
`MATCH_PROVIDER_VERSIONS`:

- **v1** — o que o processador FFmpeg já aceitava: um filtro `eq`, parâmetros
  `mode`, `brightness`, `contrast`, `saturation`.
- **v2** — acrescenta ganho por canal para white balance, renderizado como
  `colorchannelmixer` antes do mesmo `eq`; parâmetros adicionais `red-gain`,
  `green-gain`, `blue-gain`. Os nomes são em minúsculas com hífen, e não em
  camelCase, porque `createColorPlan` valida toda chave de
  `implementation.parameters` contra a gramática TOKEN de `color-and-export.ts`,
  que não aceita maiúsculas.

`MATCH_PARAMETER_BOUNDS`: brightness [-1, 1], contrast [0,1, 3],
saturation [0, 3], ganho de canal [0,5, 2].

### 30.3 Câmera de referência, limites e overrides

A câmera de referência é escolhida por alguém, e a escolha é uma atestação
cercada: `ReferenceCameraSelection` carrega quem escolheu (`MATCH_ACTOR_KINDS` =
`human | director | system`), quando, e o par `baseVersionId` + `baseHash` da
sessão que essa pessoa estava vendo. Não é medição, e é rotulada como não sendo.

`DEFAULT_MULTICAM_MATCH_POLICY` nomeia os limites:

| Campo | Valor |
|---|---:|
| `minimumSampledFrames` | 3 (o mesmo `COLOR_MEASUREMENT_MINIMUM_FRAMES`) |
| `whiteBalanceGainTolerance` | 0,02 |
| `maxWhiteBalanceGain` | 1,25 |
| `maxBrightnessOffset` | 0,2 |
| `maxExposureCorrectionEv` | 1 |
| `contrastRange` | [0,67; 1,5] |
| `saturationRange` | [0,67; 1,5] |
| `exposureGamma` | 2,2 |
| `exposureDispersionEvScale` | 0,5 |
| `gainDispersionScale` | 0,1 |
| `singleRangeConfidenceCap` | 0,8 |

Uma correção além do limite é **grampeada no limite** e o plano diz isso com
`humanReviewRequired`; ela não é aplicada em força total nem descartada em
silêncio. Um único par de intervalos não estima dispersão e por isso não pode
reivindicar confiança alta: o teto é 0,8.

Um override é por câmera e opcionalmente por `segmentId` ou por intervalo de
ticks, com motivo e ator (`MatchRangeOverride`). Ele desloca a transformação
daquele trecho; não apaga a medição que estava lá.

### 30.4 Recusas fail-closed

Nenhuma delas devolve um match aproximado:

| Código | Quando |
|---|---|
| `COLOR_REFERENCE_UNAVAILABLE` | a câmera de referência não tem medição alguma |
| `COLOR_HDR_SDR_UNSUPPORTED` | alguma medição é `hlg` ou `pq`; não existe tone-map no pipeline |
| `COLOR_SOURCES_INCOMPARABLE` | uma câmera foi medida em colorimetria diferente da referência |
| `COLOR_MEASUREMENT_INSUFFICIENT` | faltam quadros ou dimensões comparáveis |
| `COLOR_RANGES_NOT_COMPARABLE` | os intervalos medidos de uma câmera nunca cruzam os da referência |
| `COLOR_STAGE_VIOLATION` | a transformação não é do estágio `match`, ou vem depois da LUT criativa |
| `CAMERA_IDENTITY_COLLISION` | duas faixas dobram para a mesma chave de câmera |

O HDR é recusado **antes** da comparação de colorimetria, de propósito: dizer
"incomparável" esconderia que o problema é a ausência de tone-map, não uma
diferença de números.

### 30.5 Medido

`tests/v2/color-visual-evaluations.integration.mjs`, executado nesta máquina
(7 casos, 7 passes; nos dois primeiros, N=2 é o número de intervalos medidos por
câmera):

- **Duas câmeras.** Razão azul/verde da referência 1,047486. Antes do match a
  câmera B media 0,916081 — 12,54 % de erro; depois, 1,046333 — 0,11 %. Ganho
  aplicado 1,143444, confiança 0,995497.
- **Três câmeras.** Erro de azul 12,54 % → 0,11 %; erro de vermelho
  17,03 % → 1,05 %; confiança 0,981982.
- **Mesma câmera casada sob duas LUTs criativas diferentes.** A LUT fria deixa
  bOverG 1,089309 / rOverG 0,948087; a quente, 0,999065 / 1,065208. Separação
  medida de 0,0828 em azul e 0,1235 em vermelho, e digests distintos
  (`d287273c4e20` contra `213a61b09742`): o match não apaga a intenção criativa
  que vem depois dele.

## 31. Crítico de cor (F4.014)

Implementa FR-184. `src/v2/domain/color-critic-report.ts`, com o avaliador em
`src/v2/infrastructure/media/ffmpeg-color-critic-evaluator.ts`.

### 31.1 O que é lido, e onde

`COLOR_CRITIC_STAGES` é `before-output-transform` e `after-output-transform`;
`COLOR_CRITIC_ACROSS_STAGES = 'across-output-transform'` nomeia a dimensão que
só existe comparando os dois lados. Medir apenas depois do transform confundiria
intenção criativa com defeito; medir apenas antes não veria o que o transform
fez.

`COLOR_CRITIC_DIMENSIONS` são doze, cada uma com unidade fixa
(`COLOR_CRITIC_UNITS`): `clipping` e `crushedBlacks` (ratio), `cast`,
`whiteBalanceMismatch` e `brandColorDrift` (ratio-delta), `exposureMismatch`
(ev), `saturationExcess` e `saturationDeficit` (ratio), `skinToneOffTarget`
(degrees), `localizedMismatch` (ratio), `hdrSdrInconsistency` e
`matchRegression` (count).

Três subconjuntos fecham o que cada dimensão pode significar:

- `COLOR_CRITIC_REQUIRED_DIMENSIONS` — `clipping`, `crushedBlacks`, `cast`,
  `hdrSdrInconsistency`, `matchRegression`: se não puderem ser lidas, nada se
  sabe sobre os bytes e não há veredito.
- `COLOR_CRITIC_BETWEEN_CAMERA_DIMENSIONS` — `whiteBalanceMismatch`,
  `exposureMismatch`, `localizedMismatch`: `not-applicable` com uma câmera,
  **obrigatórias** com duas ou mais. Comparação ilegível num sujeito
  multicâmera é evidência faltando, não defeito ausente.
- `COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS` — `clipping`, `crushedBlacks`,
  `skinToneOffTarget`, `brandColorDrift`, `hdrSdrInconsistency`: nenhum ganho do
  estágio `match` desfaz. Amostra ceifada não guarda valor para restaurar.
- `COLOR_CRITIC_CORRECTABLE_DIMENSIONS` — as sete que uma rederivação limitada
  do estágio `match` ainda alcança.

`DEFAULT_COLOR_CRITIC_THRESHOLDS` (calibração `color-critic-thresholds/v1`) dá
dois limiares por dimensão, `warn` e `hard` — um número só faria "um pouco
acima" e "arruinado" darem o mesmo veredito:

| Dimensão | warn | hard |
|---|---:|---:|
| `clipping` | 0,005 | 0,02 |
| `crushedBlacks` | 0,005 | 0,02 |
| `cast` | 0,03 | 0,08 |
| `whiteBalanceMismatch` | 0,03 | 0,08 |
| `exposureMismatch` | 0,15 | 0,35 |
| `saturationExcess` | 1,15 | 1,35 |
| `saturationDeficit` | 0,87 | 0,7 |
| `skinToneOffTarget` | 8 | 15 |
| `localizedMismatch` | 0,001 | 0,001 |
| `brandColorDrift` | 0,03 | 0,08 |
| `hdrSdrInconsistency` | 1 | 1 |
| `matchRegression` | 1 | 1 |

### 31.2 Ações

`COLOR_CRITIC_ACTIONS` é `approve | bounded-correction | human-review | reject`.
A ação não é a média dos números: ela é lida numa tabela de causa,
`COLOR_CRITIC_CAUSE_ACTIONS`, e a causa é escolhida na ordem de
`COLOR_CRITIC_CAUSE_PRECEDENCE` (a primeira que se aplica decide):

| Causa | Ação |
|---|---|
| `irreversible-technical-defect` | `reject` |
| `evidence-unavailable` | `human-review` |
| `correction-budget-exhausted` | `human-review` |
| `correction-confidence-insufficient` | `human-review` |
| `correction-out-of-bounds` | `human-review` |
| `correction-not-derivable` | `human-review` |
| `correctable-technical-defect` | `bounded-correction` |
| `advisory-warning` | `approve` |
| `documented-intent` | `approve` |
| `no-defect` | `approve` |

Um defeito duro **medido** vence uma dimensão que ninguém conseguiu ler: saber
que um quadro está ceifado não fica menos certo porque uma segunda pergunta
ficou sem resposta. Tudo abaixo de um defeito duro medido cai para um humano.

`COLOR_CRITIC_CLASSIFICATIONS` (`technical-defect`, `documented-intent`,
`insufficient-evidence`, `localized`, `global`) e
`COLOR_CRITIC_SEVERITIES` (`hard`, `warning`) descrevem a questão; o sujeito é
um de `COLOR_CRITIC_SUBJECT_KINDS` (`source`, `camera`, `range`, `output`).

### 31.3 Limites de correção

- `COLOR_CRITIC_BOUNDED_CORRECTION_MINIMUM_CONFIDENCE = 0,85` — uma correção
  automática precisa da banda `high`. Abaixo disso vai para um humano: correção
  reversível aplicada sobre número em que ninguém confia é exatamente a
  aprovação por silêncio que este repositório existe para impedir.
- `COLOR_CRITIC_MAX_CORRECTION_ITERATIONS = 2` — esgotado o orçamento, a causa é
  `correction-budget-exhausted` e a ação é `human-review`.
- `DEFAULT_COLOR_CRITIC_POLICY` limita o que uma correção pode propor:
  `maxProposedExposureEv` 0,75; `maxProposedGain` 1,25;
  `proposedSaturationRange` [0,67; 1,5]; `contrastRegressionRatio` 0,7;
  `exposureGamma` 2,2; `skinTargetHueDegrees` 136,13.
- `maxDeclaredCastAllowance = 0,25` é o teto do que uma intenção criativa pode
  declarar como cast aceitável, e é `maxProposedGain - 1`: um look declarado
  pode deslocar a razão entre canais no máximo o que o estágio `match` teria
  permissão de aplicar para desfazê-lo. Não é múltiplo do limiar `hard` de
  `cast`, que vale 0,08 (`color-critic-report.ts:244`) — o teto é 3,1 vezes
  esse limiar, e quem estiver orçando quanto cast uma declaração desculpa
  precisa do número, não da razão. Sem teto, o chamador escreveria o próprio
  veredito:
  bastaria declarar uma tolerância grande o suficiente para transformar qualquer
  cast em `documented-intent`/`approve`.

O avaliador é `COLOR_CRITIC_EVALUATOR = { id: 'apollo-color-critic', kind:
'controlled' }`, e o relatório diz isso de si mesmo: o crítico não lê pixels,
compara agregados de medição contra limiares versionados.

### 31.4 Medido

Mesma suíte da §30.5, executada nesta máquina:

- **Clipping declarado como estética continua sendo defeito.** Com
  `highlights = 0,500000`, a ação é `reject` por
  `irreversible-technical-defect`, com o declarante ou sem ele. O controle da
  mesma suíte (valor 0) sai como `human-review`/`correction-not-derivable` — o
  positivo e o negativo, lado a lado.
- **Cast declarado é preservado; o mesmo cast sem declaração é defeito.** Cast
  medido 0,201998: declarado, a classificação vira `documented-intent` e as
  questões de cast caem para zero; a rejeição que sobra é
  `skinToneOffTarget`, que a declaração não cobre.
- **Um desencontro confinado a um segundo é reportado como aquele intervalo.**
  Fração 0,5 no intervalo `[1000, 2000)` da câmera `cam-b`, e em nenhum outro.
- **Uma mancha de pele CONTROLADA é medida por máscara de banda e nunca é
  chamada de pele real.** Matiz 133,104086, área 1, desvio 3,025914, avaliador
  `ycbcr-skin-band-mask/controlled`; sem pixels na banda, a dimensão sai
  `not-applicable`, não zero.

## 32. React PlaybackMap (F4.015)

Implementa §16. `src/v2/domain/playback-map.ts` (agregado),
`playback-mode.ts` (vocabulário sem dependências, para a página do editor de
âncoras) e `src/v2/infrastructure/media/ffmpeg-playback-fingerprint.ts` (o
correlacionador). Ver [ADR-152](../adr/ADR-152-react-playback-map-aggregate.md)
para por que isto é um agregado próprio e não um `PiecewiseClockMap`.

### 32.1 Modos e peças

`PLAYBACK_MODES` são seis: `playing`, `paused`, `rewind`, `replay`, `seek`,
`commentary-only`. `NO_REFERENCE_PLAYBACK_MODES` — `paused` e `commentary-only` —
são aqueles em que a referência não produz tempo nenhum, e por isso a peça não
tem `referenceRange`.

O mapa é **reação → referência**, e a direção importa: intervalos da reação
nunca se sobrepõem (o reactor viveu cada instante uma vez), enquanto intervalos
da referência podem repetir, correr para trás ou faltar.

`PLAYBACK_DIRECTIONS` (`forward`, `backward`, `none`) descrevem a *fronteira*,
não o interior: uma peça de rewind corre para frente dentro de si; o que a faz
rewind é ter começado atrás de onde a peça anterior parou.

`PLAYBACK_DISCONTINUITY_REASONS` faz spread de `PIECE_BOUNDARY_CAUSES` da
Wave 18 — `recorder-restart`, `pts-regression`, `seek`, `rewind`, `file-split`,
`coverage-gap`, `residual-exceeded`, `manual-anchor-conflict` — e acrescenta os
três que só acontecem a um *player*: `pause`, `commentary`, `manual-anchor`.

`PLAYBACK_DETECTION_METHODS` são `audio-fingerprint`, `player-visual`,
`ocr-timestamp` e `manual-anchor`. Só o primeiro mede taxa hoje; os outros três
existem para que o agregado consiga registrar uma peça que veio de uma pessoa ou
da interface do player sem fingir que um correlacionador a produziu.

A duração da reação nunca implica a da referência. `PlaybackReferenceMedia`
carrega `durationTicks` medida, com `assetId` e `sha256`: bytes diferentes são
outro mapa.

### 32.2 Evidência

`PLAYBACK_FINGERPRINT_DEFAULTS`: `sampleRate` 16 000 Hz, `windowMs` 1000,
`hopMs` 500, `energyFloor` 0,01 (−40 dBFS), `minimumPeak` 0,5,
`correlationRate` 2000 Hz. O piso de pico existe porque o teste de pico sobre
vice-pico não o enxerga sozinho: uma janela de ruído de sala também tem um
melhor deslocamento e um segundo melhor, e a razão entre eles fica bem acima do
piso de admissão.

O que o agregado não sabe medir, ele recusa em vez de escolher:

- `PLAYBACK_UNCOVERED_REASONS` — `manual-anchor-required` (o player estava
  escondido; "tocou", "pausou e pulou" e "arrastou" cabem igualmente na
  evidência) e `conflicting-evidence`.
- `PLAYBACK_MAP_WARNINGS` — `manual-anchor-required`, `conflicting-evidence`,
  `rate-unmeasured`, `reference-exhausted`, `no-reference-detected`.
- `PLAYBACK_MAP_STATUSES` — `resolved`, `needs-input`, `failed`. Um mapa com
  trecho descoberto é `needs-input`, e não um `resolved` com um buraco; um mapa
  em que nenhuma peça encontrou a referência é `failed`.

Uma âncora manual usa a mesma forma de `DiagnosticAnchor`/`ANCHOR_ORIGINS` da
Wave 19, e a nota do operador cabe em `PLAYBACK_ANCHOR_NOTE_MAX = 1000`
caracteres.

Recusas nomeadas: `PLAYBACK_EVIDENCE_INSUFFICIENT`, `PLAYBACK_MAP_UNRESOLVED`,
`PLAYBACK_MAP_VERSION_STALE` (com a versão e o hash correntes),
`PLAYBACK_SESSION_NOT_REACT`, `PLAYBACK_REACTION_TRACK_AMBIGUOUS`,
`PLAYBACK_TRACK_NOT_SINGLE_PART`, `PLAYBACK_MAP_NOT_FOUND`.

### 32.3 Materialização é só corte

A compilação transforma o mapa num plano renderizável cuja linha do tempo é a
**da reação**, peça por peça, e o compilador afirma isso em vez de deixar
implícito: o número de quadros do plano é comparado com o da reação e diverge no
máximo um quadro.

A limitação é declarada nas próprias `assumptions` do plano: a materialização é
só corte. Um trecho pausado mostra o reactor, não um quadro congelado da
referência, porque o caminho editorial não tem freeze (`clip-timing.ts` recusa
taxa zero) nem picture-in-picture. `retainedSourceRanges` lista o que sobrevive
da referência, em segundos dela; a reação não aparece ali porque ela não é um
intervalo de origem retido — ela é a linha do tempo.

### 32.4 Medido

`tests/v2/playback-map-fingerprint.integration.mjs`, executado nesta máquina
sobre uma gravação de react gerada: referência 30,00 s (h264/aac), reação
60,00 s, 119 janelas das quais 69 travaram, 8 peças, 1 trecho descoberto, status
`needs-input`. O erro de fronteira medido em cada peça foi 0 ou 15 quadros:

| Instante (ticks) | Modo | Erro |
|---:|---|---:|
| 0 | `playing` | 0 |
| 900000 | `paused` | 0 |
| 1575000 | `playing` | 15 |
| 2070000 | `commentary-only` | 0 |
| 3285000 | `playing` | 15 |
| 3690000 | `replay` | 0 |
| 4365000 | `seek` | 15 |
| 4770000 | `uncovered`/`manual-anchor-required` | 0 |
| 5085000 | `playing` | 15 |

Cinquenta janelas foram recusadas (27 delas com razão de pico ≥ 1,2 — isto é,
janelas que passariam num teste que olhasse só a razão), com confiança entre
0,000 e 0,950. Duas execuções produziram o mesmo `mapHash`
(`fc4646da3a638ded`).

`npm run test:e2e:playback-map` contra o mesmo cluster PostgreSQL descartável
da §33.4 (1 teste, 1 passe, 8,2 s): um mapa v1 com 8 peças e 1 trecho descoberto
recebe uma âncora manual e vira um v2 `resolved`; a compilação produz um plano
de 1200 quadros em 9 clipes e uma linha de snapshot; um segundo escritor sobre a
mesma cabeça é recusado por `PLAYBACK_MAP_VERSION_STALE` no serviço **e** por
`PERSISTENCE_CONFLICT` no banco. O plano guardado é recusado depois de um
deslocamento de clipe que passa pelo `CHECK` (`PERSISTENCE_CONFLICT`), depois de
um documento irrenderizável com hash refeito (`PERSISTENCE_CONFLICT`) e depois
de desligar a referência (`MEDIA_ARTIFACT_NOT_FOUND`).

## 33. Gate da fase multicâmera/long-form (F4.016)

`src/v2/domain/multicam-longform-gate.ts` modela o gate como dez critérios
independentes, id `multicam-longform/v1`. Os ids dos critérios são frases e não
números de série, porque "insufficient-evidence-requires-manual: failed" ensina
o que falhou e "AC-003: failed" manda o operador a uma tabela.

### 33.1 Os dez critérios

| Critério | O que ele afirma | Checagens |
|---|---|---|
| `podcast-multicam-synchronised` | podcast de dois participantes com áudios distintos sincronizado, cobertura derivada e mapa de relógio persistido | `podcast-protocol-evaluated`, `diagnostic-synchronised`, `participant-tracks-distinct`, `coverage-derived`, `clock-map-persisted` |
| `teacher-and-screen-synchronised` | professor e tela com durações diferentes sincronizados sem esticar nenhum dos dois | `teacher-protocol-evaluated`, `diagnostic-synchronised`, `track-durations-unequal`, `coverage-derived` |
| `insufficient-evidence-requires-manual` | uma sessão que a evidência não resolve diz isso, recusa inventar mapa e exige marcador ou âncora antes de qualquer edição automática | `sync-evidence-insufficient`, `diagnostic-requires-manual`, `protocol-ceiling-blocks-auto-edit` |
| `react-edited-with-piecewise-map` | react editado por mapa de playback piecewise que sobrevive a pausa, rewind ou seek, com duração de reação diferente da referência | `playback-map-persisted`, `interrupted-piece-present`, `reaction-duration-differs`, `map-compiled-into-plan` |
| `active-speaker-and-demonstration-directed` | direção multicâmera cortada por falante ativo e por demonstração, com regra e justificativa por plano | `direction-persisted`, `active-speaker-rule-fired`, `demonstration-rule-fired`, `decisions-carry-justification` |
| `contextual-multi-range-synthesis` | síntese multi-range de cerca de 120 s que guarda a sua prova de contexto e cai dentro da tolerância declarada | `synthesis-persisted`, `target-duration-is-120s`, `duration-within-tolerance`, `multiple-ranges-preserved`, `context-proof-recorded` |
| `colour-match-precedes-creative-lut` | o match de câmeras é um plano de estágio `match` e resolve antes da LUT criativa | `match-plan-persisted`, `transforms-are-match-stage`, `match-precedes-creative-lut` |
| `colour-critic-resolved` | o crítico de cor chegou a um veredito que fecha, sem questão dura em aberto | `critic-report-persisted`, `verdict-resolved`, `no-open-hard-issue` |
| `final-mp4-inspectable` | o MP4 entregue existe como artifact cujo hash, codec, dimensões, taxa e duração foram **medidos** e não declarados | `final-export-promoted`, `output-codec-recorded`, `output-probe-measured`, `artifact-hash-matches-attempt` |
| `no-legacy-runtime-dependency` | o grafo de módulos atrás de tudo acima foi varrido e não importa runtime legado nem persistência de compatibilidade | `module-graph-scanned`, `no-legacy-runtime-import`, `no-compatibility-persistence` |

São 38 checagens no total — número medido na execução da §33.4, não contado à
mão.

### 33.2 De onde vem a evidência

`MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES` é um conjunto fechado de vinte e
quatro nomes de evidência que uma checagem pode ter lido, de `workspace` a
`module-graph-audit`. Vinte e três nomeiam uma tabela do schema v2 —
`workspaces`, `projects`, `project_versions`, `capture_session_versions`,
`capture_protocols`, `capture_protocol_evaluations`, `sync_diagnostics`,
`capture_sync_evidence`, `capture_track_coverages`, `capture_clock_maps`,
`playback_maps`, `playback_pieces`, `multicam_directions`,
`multicam_shot_decisions`, `editorial_syntheses`, `multicam_match_plans`,
`camera_match_transforms`, `project_color_plans`, `color_critic_reports`,
`renderable_plan_snapshots`, `project_final_export_operations`,
`media_artifacts`, `media_artifact_manifests` — e não todas foram criadas nas
Waves 18/19/20: `workspaces` vem da migração inicial `20260712210000_init`. O
vigésimo quarto, `module-graph-audit`, **não** é tabela: `grep module_graph
prisma/v2/schema.prisma` devolve zero linhas, e a referência que o gate constrói
é `{ type: 'module-graph-audit', id: 'legacy-runtime-audit:<scannedAt>', hash:
auditHash }` (`multicam-longform-gate.ts:807-811`) — o resultado de uma
varredura, não uma linha. É o mesmo fato que a nota sobre o critério 10 registra
adiante. "evidence-ref: o que o leitor quiser" é como um gate deixa de ser
auditável.

`MULTICAM_LONGFORM_FAILURE_REASONS` são cinco, porque a próxima ação do operador
é diferente em cada uma: `evidence-missing` (grave de novo),
`evidence-unverified` (investigue a linha), `evidence-not-measured`
(meça — nulo, nunca zero), `requirement-unmet` (conserte o conteúdo) e
`evidence-stale` (re-execute contra a versão corrente).

A verificação de hash tem três estados, e o terceiro é o que torna o gate
possível: hash presente e conferido; hash presente e **não** conferido, que é
adulteração e é contada em `unverifiedReferenceCount`; e hash ausente, porque a
tabela não guarda hash próprio — contada em `unhashedReferenceCount` e nunca na
primeira. Confundir "não pude conferir" com "conferi e estava errado" tornava
quatro dos dez critérios impossíveis de registrar como aprovados, porque a
migração recusa uma linha aprovada que cite uma referência não verificada.

O critério 10 é o único cuja evidência não é uma linha de banco: "sem runtime
legado" é propriedade do código que produziu os outros nove.
`LEGACY_RUNTIME_MARKERS` fixa o que conta — `legacy-runtime-import`,
`legacy-prisma-client`, `sqlite-persistence`, `legacy-process-route`,
`dual-write-compatibility` — para que o scanner não estreite em silêncio a
própria definição. Módulos de entrada que o processo não conseguiu ler são
reportados à parte das violações.

### 33.3 Superfície

Seis capabilities `/v1` por projeto publicam o gate — executar, ler o último,
ler um pelo id, listar o histórico, ler o que falta e listar os artifacts — mais
uma sétima independente de projeto, `apollo.multicam-longform-gate.criteria.list`
em `GET /v1/multicam-longform-gate/criteria`, que publica o catálogo dos dez
critérios antes de qualquer avaliação. A tela em
`src/app/multicam-longform-gate/page.tsx`, alcançável a partir de
`/capture-sessions`, mostra os dez critérios um a um. O registro de por que essa
tela chegou depois das outras três está em
[`docs/quality/wave20-operator-surfaces.md`](../quality/wave20-operator-surfaces.md).

### 33.4 Medido

`npm run test:e2e:multicam-longform-gate` contra um cluster PostgreSQL 16
descartável levantado nesta máquina, com todas as migrações aplicadas a partir
do zero (3 testes, 3 passes, 72,9 s):

- Um projeto vazio produz 10 critérios e 38 checagens, 3 linhas de evidência, e
  satisfaz 1 de 10.
- O mundo completo, lido pelo leitor real e não por um duplo, satisfaz 10 de 10
  (sessão `f4016-session-podcast`, fingerprint `e3b5c38c6c8f`).
- Nove exclusões de uma linha cada foram medidas, e **cada uma falhou exatamente
  o seu próprio critério** — é isso que impede que os dez critérios sejam um
  critério só com dez nomes.
- Quinze recusas de constraint foram medidas no mesmo banco.
- Oito vocabulários do leitor foram conferidos contra as constantes de domínio
  que os definem, em vez de redigitados.

`npm run test:e2e:phase-gate-journey`, no mesmo cluster, dirige o gate pelas
rotas `/v1` publicadas (1 teste, 1 passe, 58,7 s): 13 avaliações, aprovação
10/10 com fingerprint `dba04547dfc6` citando 40 artifacts, e um replay
byte-a-byte idêntico de 19 955 caracteres. Apagar a cabeça do plano de match
leva a 9/10 por `evidence-missing`; adulterar a síntese leva a 9/10 por
`evidence-unverified`; restaurar volta a 10/10. Cinco corpos de requisição que
carregavam um veredito foram recusados com 422 `INVALID_ARGUMENT` e **zero**
linhas escritas — o chamador não declara o resultado do gate. Outras quatro
condições foram quebradas uma de cada vez, e cada uma derrubou exatamente a sua
checagem: podcast dessincronizado → `diagnostic-synchronised`; cobertura de uma
faixa só → `coverage-derived`; LUT criativa autorada antes do match →
`match-precedes-creative-lut`; reação do mesmo tamanho da referência →
`reaction-duration-differs` e `map-compiled-into-plan`.

## 34. Estado de implementação — Wave 20 (F4.012–F4.016)

Implementado localmente entre 2026-09-04 e 2026-09-06. **Integração final,
deploy e aceite do proprietário não aconteceram**; nenhuma caixa de F4.012 a
F4.016 no `TODO.md` está marcada.

### 34.1 O que foi construído

| Seção | Módulo de domínio | Evidência |
|---|---|---|
| §29 Direção multicâmera | `multicam-direction.ts`, `multicam-evidence.ts`, `camera-identity.ts` | T-FR-150 (33 casos), T-F4.012 (21 casos de serviço) |
| §30 Match de cor | `color-measurement.ts`, `multicam-match-plan.ts` | T-FR-183/T-FR-184 (43 casos), T-F4.013/T-F4.014 (30 casos de serviço) |
| §31 Crítico de cor | `color-critic-report.ts` | T-FR-184, `color-visual-evaluations.integration.mjs` (7 avaliações) |
| §32 React PlaybackMap | `playback-map.ts`, `playback-mode.ts` | T-F4.015 (31 casos + 16 de serviço) |
| §33 Gate da fase | `multicam-longform-gate.ts` | T-F4.016 (16 casos), `E2E-F4.016` |

Persistência em 33 modelos Prisma novos, distribuídos por seis migrações, todas
aplicáveis do zero: medido levantando um PostgreSQL 16 vazio nesta máquina e
rodando `db:v2:migrate:deploy`, que respondeu "All migrations have been
successfully applied".

`npm run db:v2:validate` respondeu nesta máquina, em 2026-09-06, "267 tabelas,
1247 índices, 935 chaves estrangeiras" — a nota da Wave 18 no `TODO.md` havia
registrado 227 / 1099 / 850. O registry de capabilities passou de 325 entradas em
`041eb97d` para 347 em `HEAD`, e `npm run api:v1:validate` respondeu no mesmo dia
"347 capabilities, 606 schemas, 671 examples, 282 paths, compatibility baseline
intact". Quatro telas de operador: direção, cor, playback e gate.

### 34.2 O worker de sincronização — o que passou a existir

A §27.1 registra a correção: até a Wave 20, `POST .../sync-runs` enfileirava uma
linha que nenhum processo consumia. O que existe agora, e é executável:

- **Driver**: `scripts/run-v2-capture-sync-worker.mjs`, script npm
  `worker:v2:capture-sync`, com `--once` para CI.
- **Fonte de sinal**: `ffmpeg-audio-sync-signal-source.ts`, a primeira
  implementação de `SyncSignalSource` que o worker já esperava, apoiada em
  `correlateAudioWindows`.
- **Cobertura derivada dentro do worker**, em vez de nenhum produtor:
  `createTrackCoverage` passou a ter chamador de produção.
- **Sem taxa de quadros inventada**: o fallback `30000/1001` saiu; a taxa vem do
  relógio persistido ou do timebase da faixa de referência, e sem nenhum dos
  dois o run é liquidado como falho com o motivo nomeado.

Medido nesta máquina (`npm run test:integration:capture-sync-worker`, 11 testes,
11 passes): quatro atrasos conhecidos sobre relógio de sessão de 90 kHz deram
erro de 0, 0, +18 e 0 ticks (média 4,50 t, desvio 7,79 t, N=4); o único erro não
nulo é o atraso deliberadamente fora da grade de correlação, e vale 0,200 ms.
Áudio embaralhado sai como `insufficient-evidence` com zero sinais e zero mapas,
em vez de virar um deslocamento. Uma separação mais fraca reporta confiança
estritamente menor (razão de pico 2,4882 → confiança 0,8755, `auto-apply`;
razão 1,4037 → confiança 0,6555, `review`). Uma câmera sem microfone não produz
observação alguma — não produz zero.

### 34.3 O que continua faltando

- **Drift continua sem ser ajustado.** `fitClockDrift` e `capture_drift_fits`
  seguem sem escritor; o diagnóstico segue relatando `driftPpm: null`, que é
  "não medido". Isso significa que `rate` numa peça de playback (§32) vem da
  correlação daquela peça, e não de um ajuste de drift da sessão.
- **`SessionClock` continua sem escritor.** O worker resolve a taxa de quadros,
  usa e não persiste.
- **Marcador confirmado continua não sendo prova admissível** pela cascata, pelo
  motivo registrado na §27.3: `MarkerDetection` guarda os ids das observações,
  não o pico e o segundo pico que a fusão mediu.
- **`spoken-code` continua sem reconhecedor de fala.**
- **Freeze e picture-in-picture não existem.** A materialização de um react é só
  corte (§32.3); a spec §16 descreve o mapa, não uma composição.
- **Os limiares de §26 continuam sem calibração contra material real.** Todos os
  números das §§29–31 vieram de fixtures geradas.

### 34.4 Round trip contra PostgreSQL

`npm run test:e2e:wave20-persistence` no mesmo cluster (2 testes, 2 passes,
7,9 s) mede as três coisas que um duplo em memória não mede:

- **`bigint` sobrevive.** O tick 9 007 199 254 740 993 — um a mais que o maior
  inteiro exato de um `double` — voltou do driver como foi escrito. Se
  atravessasse como número JSON, voltaria arredondado, sem erro.
- **As constraints recusam o que o domínio recusa.** 28 recusas confirmadas na
  mesma passada, com duas peças de playback preservadas depois da cascata de
  exclusão da direção.
- **Os repositórios devolvem o agregado que foi guardado**: direção com 4 planos
  e 1 trecho descoberto, medição com 8 dimensões, plano de match com 2 questões,
  relatório de crítico com 12 dimensões, mapa de playback com 8 peças na v1 e 9
  na v2.

### 34.5 O que não foi medido neste passe

Este documento foi escrito com `npm test` (2147 testes, 2147 passes, saída 0),
seis suítes de integração de mídia da Wave 20 e quatro suítes de banco contra um
cluster PostgreSQL 16 descartável levantado localmente e destruído em seguida.
**Não** foram executadas aqui: as jornadas de navegador
(`test:e2e:wave20-browser`, `test:e2e:multicam-longform-gate-browser`), que
exigem `next start` e um build de produção, nem as jornadas de produto de
podcast, professor+tela, react, evidência insuficiente e síntese long-form
contra PostgreSQL. Elas existem, estão registradas em passos nomeados do CI, e
são medidas lá.

Nada nesta seção afirma implantação ou aceite. Os dois continuam pendentes.
