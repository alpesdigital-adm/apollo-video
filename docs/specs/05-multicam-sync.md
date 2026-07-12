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

