# Spec 08 — Localização Multi-idioma e Direção de Áudio

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **PRD relacionado:** FR-190–205

---

# Parte A — Localização

## 1. Objetivo

Gerar variantes por idioma/mercado preservando intenção, claims, identidade e qualidade, com áudio, alignment, legendas, timeline e assets localizados próprios.

## 2. Invariantes

1. Locale variant nunca reutiliza timestamps do áudio original.
2. Tradução não altera claim, número ou qualifier sem registro/aprovação.
3. Glossário e protected terms prevalecem.
4. Voice/avatar rights são verificados por locale/market.
5. Texto dentro de mídia é detectado e tratado.
6. RTL/font/line breaking pertencem ao LocaleProfile.
7. StoryPlan pode ser compartilhado; EditPlan temporal é recompilado.
8. Depoimento dublado não pode sugerir fala real sem consent/disclosure.

## 3. LocalizationVariant

```ts
interface LocalizationVariant {
  id: string
  projectVersionId: string
  sourceLocale: string
  targetLocale: string
  market?: string
  canonicalScriptVersionId: string
  localizedScriptVersionId: string
  audioAssetId?: string
  alignmentId?: string
  visualMode: 'lip-sync' | 'avatar' | 'voiceover' | 'subtitles-only'
  localePlanId?: string
  status: LocalizationStatus
  qualityReportId?: string
}
```

## 4. State machine

```text
draft
→ extracting-canonical
→ translating
→ validating-terminology
→ adapting-duration
→ generating/importing-audio
→ aligning
→ generating-visual
→ localizing-assets
→ compiling-plan
→ rendering-proxy
→ reviewing
→ ready | failed | blocked
```

## 5. Canonical ScriptBlocks

Cada bloco registra:

- source text/locale;
- role;
- protected claims/numbers/names;
- qualifiers;
- pronunciation terms;
- target duration range;
- dependencies;
- on-screen text refs;
- permitted adaptation level.

## 6. Translation/adaptation policy

### 6.1 Níveis

- `literal-required`: termos legais, claims, preço, condição.
- `meaning-preserving`: explicação e narrativa.
- `cultural-adaptation`: expressões, hook e CTA, sem mudar promessa.
- `rewrite-allowed`: somente se briefing autorizar e claims protegidos permanecerem.

### 6.2 Checks obrigatórios

- números/moedas/unidades;
- negação;
- comparativos/superlativos;
- prazo;
- nomes/handles/URLs;
- oferta/CTA;
- qualifiers;
- disclosure.

### 6.3 Conflict table

| Conflito | Ação |
|---|---|
| tradução natural excede duração | resumir meaning-preserving; depois ajustar visual/track |
| claim fica ambíguo | bloquear e pedir revisão |
| termo sem equivalente | glossary/transliteration/nota |
| CTA não existe no mercado | usar LocaleProfile ou bloquear |
| handle muda por mercado | usar profile, nunca inventar |

## 7. LocaleProfile

```ts
interface LocaleProfile {
  locale: string
  market?: string
  direction: 'ltr' | 'rtl'
  glossaryId: string
  prohibitedTranslations: string[]
  pronunciationDictionaryId?: string
  toneRules: string[]
  currency?: string
  unitSystem?: string
  socialHandles?: Record<string, string>
  ctaTemplates?: Record<string, string>
  requiredDisclosures: string[]
  fonts: FontFallback[]
  lineBreakPolicy: Record<string, unknown>
}
```

## 8. Duration adaptation

Fluxo:

1. estimar fala localizada;
2. comparar com target range;
3. adaptar texto dentro do permitted level;
4. gerar/importar áudio;
5. medir duração real;
6. recompilar timeline/B-roll/layouts;
7. nunca time-stretch agressivo para “caber”.

Default de variação aceitável sem replanejar story: ±15% do bloco. Acima, recompilar blocos dependentes; threshold calibrável.

## 9. Áudio localizado

Modos:

- TTS/voice clone autorizado;
- voz local;
- áudio humano enviado;
- áudio humano gravado;
- original com subtitles-only.

Transcript do áudio final é comparado ao localized script. Nomes/números divergentes são blocker.

## 10. Alignment

Word-level alignment pertence ao áudio final. Subtitle cues, scene boundaries e lip-sync referenciam esse alignment. Falha de alignment impede auto-render com face/lips; voiceover pode seguir com cue de menor granularidade e review.

## 11. Visual modes

### Lip-sync existing footage

Preserva corpo/cenário; exige critic e consent.

### Regenerate avatar

Usa áudio localizado, profile compatível e continuidade visual.

### Voiceover

Oculta rosto conforme plan e usa B-roll/tela/typography.

### Subtitles-only

Áudio original; não é dubbing. Pode ser policy preferida para depoimentos.

## 12. Assets com texto

Para cada OCR region:

- `share`: texto não precisa mudar;
- `replace-overlay`: reconstruir texto fora da imagem;
- `localize-derivative`: editar asset;
- `regenerate`: gerar nova mídia;
- `reject`: risco/qualidade inviável.

Logo/nome próprio não é traduzido sem Brand/Locale rule.

## 13. Typography e RTL

- Font fallback deve cobrir glyphs.
- Medir texto renderizado, não estimar por caracteres.
- RTL afeta alinhamento, order, animation e punctuation.
- Karaoke word progression segue ordem linguística/visual correta.
- CJK/Thai e outros exigem segmentação específica, não whitespace ingênuo.

## 14. Localized subtitles

Geradas do áudio final, com style responsivo. Critérios:

- reading speed policy por locale;
- max lines/words adaptativo;
- punctuation natural;
- no orphan glyph/line;
- safe areas;
- word highlight alinhado;
- sidecar SRT/VTT opcional.

## 15. Localization critic

Score/gates:

- semantic fidelity 25;
- protected claims/qualifiers gate;
- cultural naturalness 15;
- terminology 15;
- pronunciation/audio 15;
- lip-sync/visual 15;
- subtitles/typography 10;
- CTA/market/disclosure 5.

Elegível ≥75 e gates pass. Claims/números/consent são blockers.

## 16. Cenários Given/When/Then — localização

### LOC-01 — Duração maior

**Given** espanhol 25% mais longo  
**When** adaptação não reduz sem perda  
**Then** timeline/B-roll são recompilados; fala não é acelerada agressivamente.

### LOC-02 — Depoimento

**Given** testemunho sem consentimento para dubbing  
**When** versão EN é solicitada  
**Then** usar subtitles-only ou omitir, nunca clonar voz.

### LOC-03 — Claim

**Given** “R$ 12.400 em 30 dias”  
**When** tradução altera número/prazo  
**Then** gate bloqueia variante.

### LOC-04 — Card com texto

**Given** image card PT  
**When** EN é criado  
**Then** OCR region é substituída/regenerada e derivative mantém lineage.

---

# Parte B — Direção de áudio, música e SFX

## 17. Objetivo

Definir contrato futuro para fala, trilha e SFX em modos narrative-led, music-led e hybrid.

## 18. Invariantes

1. Fala inteligível tem prioridade salvo projeto sem fala.
2. Music-led orienta cortes visuais, não mutila frases.
3. Beat grid é análise versionada do MusicAsset.
4. Rights de música/SFX são gates.
5. Mix é determinístico e reproduzível.
6. SFX possui budget e repetition group.
7. Áudio original/master não é sobrescrito.

## 19. AudioDirectionPlan

```ts
interface AudioDirectionPlan {
  syncMode: 'narrative-led' | 'music-led' | 'hybrid'
  speechTracks: SpeechTrackPlan[]
  music?: MusicTrackPlan
  beatGridId?: string
  energyCurve: EnergyPoint[]
  events: AudioEvent[]
  mix: MixPlan
  rightsSnapshotIds: string[]
}
```

## 20. Music analysis

Registrar:

- BPM/confidence;
- beat/downbeat timestamps;
- meter/bars;
- sections intro/build/drop/break/outro;
- energy curve;
- vocals/speech interference;
- loop/edit points;
- key/mood quando útil;
- loudness/peaks;
- rights.

Beat confidence baixa impede snapping automático rígido.

## 21. Sync modes

### Narrative-led

- timeline de fala primeiro;
- escolher/editar faixa compatível;
- alinhar section changes a viradas próximas;
- ducking e fades;
- CTA pode coincidir com resolução musical.

### Music-led

- música/beat grid primeiro;
- selecionar clips/durações compatíveis;
- cuts em downbeats/phrase changes;
- fala entra em janelas naturais;
- não cortar/esticar fala além da policy.

### Hybrid

- fala natural governa semântica;
- eventos importantes snap ao beat mais próximo dentro de tolerance;
- se nearest beat excede tolerance, preservar fala.

Default tolerance hybrid: até 4 frames para evento visual curto; configurável por fps/tempo musical.

## 22. MusicTrackPlan

- source range/loops;
- timeline range;
- section mapping;
- gain envelope;
- ducking sidechain;
- fades;
- edit/crossfade points;
- locale/output overrides quando necessários.

## 23. AudioEvent/SFX

```ts
interface AudioEvent {
  id: string
  type: 'sfx' | 'impact' | 'riser' | 'transition' | 'duck' | 'music-edit'
  anchor: { frame: number; alignment: 'exact' | 'nearest-beat' | 'nearest-downbeat' | 'semantic' }
  assetId?: string
  intent: string
  gainDb: number
  fadeInFrames?: number
  fadeOutFrames?: number
  repetitionGroup?: string
}
```

## 24. Sound budget

Policy define max events/minuto, min spacing por repetition group, max concurrent foreground events e intensidade por ato. Hook admite maior densidade; CTA simplifica.

Não adicionar whoosh em todo corte. Evento deve apoiar transição, reveal, claim, prova, transformação ou humor intencional.

## 25. MixPlan

```ts
interface MixPlan {
  targetLoudness: number
  truePeakLimit: number
  speechPriority: boolean
  musicBaseGainDb: number
  duckingDb: number
  attackMs: number
  releaseMs: number
  limiter: boolean
  roomTonePolicy: 'preserve' | 'fill' | 'none'
}
```

Targets pertencem ao DeliveryProfile e serão definidos/calibrados, não hardcoded globalmente.

## 26. Room tone e cortes

Remoção de silêncio/retake não deve produzir buraco acústico. Preservar room tone, usar crossfade ou fill autorizado. Click/pop e mudança brusca de noise floor são issues técnicos.

## 27. Audio critic

Hard:

- missing speech;
- clipping/invalid file;
- rights;
- sync drift severo;
- speech unintelligible.

Soft:

- masking;
- music energy mismatch;
- SFX repetition;
- tail cut;
- abrupt room tone;
- CTA em seção musical fraca;
- beat/cut residual;
- synthetic voice artifacts.

## 28. Falhas/fallback

| Falha | Fallback |
|---|---|
| beat confidence baixa | narrative-led/free timing |
| música sem rights | outra faixa/sem música |
| SFX ausente | omitir, não gerar placeholder |
| masking | aumentar ducking/trocar faixa |
| music-led conflita com fala | preservar fala e usar hybrid |
| localized audio muda duração | recompilar sections/mix |

## 29. Observabilidade

- locale duration deltas;
- translation/claim failures;
- TTS/lip-sync retries;
- subtitle reading issues;
- BPM/beat confidence;
- SFX density/repetition;
- loudness/true peak;
- masking issues;
- music reuse/licensing;
- render/mix cost.

## 30. Cenários Given/When/Then — áudio

### AUD-01 — Hybrid

**Given** frase forte termina 3 frames antes de downbeat  
**When** evento visual é planejado  
**Then** snap ao downbeat respeitando fala e tolerance.

### AUD-02 — Beat distante

**Given** nearest beat exige mover cut 12 frames e prejudica palavra  
**When** hybrid resolve  
**Then** mantém cut semântico, sem snap.

### AUD-03 — SFX repetido

**Given** cinco whooshes do mesmo group em 8s  
**When** sound budget valida  
**Then** eventos excedentes são removidos/sinalizados.

### AUD-04 — Masking

**Given** música vocal compete com CTA  
**When** critic avalia  
**Then** duck/troca/remoção é proposta antes do final.

## 31. Critérios de aceite

1. Cada locale possui script/audio/alignment/plan próprios.
2. Protected claims e números são gates.
3. Duration delta recompila timeline em vez de deformar fala.
4. Rights/consent variam por locale/market.
5. OCR assets são classificados share/localize/reject.
6. RTL e fonts são validados no render.
7. Subtitle timing vem do áudio final.
8. AudioDirectionPlan suporta três sync modes.
9. Beat confidence controla snapping.
10. Music-led não corta fala arbitrariamente.
11. Mix targets pertencem ao DeliveryProfile.
12. SFX budget evita repetição.
13. Critic localiza masking/drift/tails.
14. Outputs locale×format mantêm lineage/cache.

## 32. Questões para ADR/calibração

- Translation/TTS/alignment providers.
- Processo de revisão humana por market.
- Dubbing disclosure policy.
- Font licensing/fallback.
- Beat/downbeat analyzer.
- Music/SFX licensing catalog.
- Mix/master implementation e targets por plataforma.
