# Spec 02 — EditPlan v2, Commands, Versionamento e Invalidação

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **PRD relacionado:** FR-070–076, FR-160–165, FR-210–224, FR-230–236

---

## 1. Objetivo

Definir o contrato canônico que conecta StoryPlan, fontes, edição manual, Diretor, variantes de formato/idioma, renderer, histórico e regeneração incremental.

O EditPlan é uma timeline determinística. Ele não contém raciocínio aberto, queries de biblioteca, prompts de provider ou decisões pendentes.

## 2. Escopo e non-goals

Incluído:

- time domains;
- tracks e clips;
- source↔timeline mapping;
- locale/format variants;
- Command/Patch model;
- validação transacional;
- versionamento/fork;
- protected elements;
- concorrência;
- dependency graph e invalidation;
- migrations;
- compiler/renderer boundary;
- diff, undo e restore.

Não incluído:

- lógica editorial do Diretor;
- algoritmos de sincronização;
- UI detalhada;
- implementação do renderer;
- schema físico definitivo do banco.

## 3. Camadas

```text
StoryPlan
  semântica e dependências
        ↓
EditorialTimeline
  ordem, source selections e papéis
        ↓
EditPlanV2
  tracks/ranges frame-first
        ↓
LocaleVariantPlan
  áudio/alignment/timing por idioma
        ↓
FormatVariantPlan
  crop/layout/placement por canvas
        ↓
RenderInput
  URLs e props resolvidos
```

Uma camada não deve absorver responsabilidade da próxima.

## 4. Time domains

### 4.1 Source time

Tempo original da fonte, preservando PTS/timebase. Usado para lineage e sync.

### 4.2 Normalized source time

Tempo da versão normalizada/proxy, com mapa explícito para source time.

### 4.3 Session time

Relógio canônico de CaptureSession multicâmera.

### 4.4 Editorial timeline time

Ordem final de narrativa antes das derivações de locale/formato.

### 4.5 Variant timeline time

Timeline recompilada para idioma quando duração da fala muda. Formato visual não deve alterar duração, salvo override explícito.

## 5. Invariantes

1. Frames inteiros são fonte de verdade de cada timeline compilada.
2. Ranges são semiabertos `[startFrame, endFrame)`.
3. `endFrame > startFrame`.
4. Source e timeline ranges nunca são confundidos.
5. Playback rate deve ser positivo, finito e dentro da policy da track.
6. Clip referencia source/derivative existente e autorizado.
7. Plano publicado é imutável.
8. Mudança cria nova ProjectVersion.
9. Toda mudança possui Command, Patch e autor.
10. Renderer não consulta banco nem escolhe fallback.
11. Format override não altera outros formatos.
12. Locale variant não reutiliza alignment de outro locale.
13. Protected element bloqueia Director/System; usuário explícito pode desbloquear conforme policy.
14. Job de versão stale não produz commit.
15. Migration é explícita e testada.

## 6. EditPlanV2

```ts
interface EditPlanV2 {
  schemaVersion: 2
  id: string
  projectVersionId: string
  storyPlanId: string
  fps: number
  durationFrames: number
  sources: PlanSource[]
  videoTracks: VideoTrack[]
  overlayTracks: OverlayTrack[]
  subtitleTracks: SubtitleTrack[]
  audioTracks: AudioTrack[]
  effectTracks: EffectTrack[]
  markers: TimelineMarker[]
  protectedElements: ProtectedElement[]
  localeVariantRefs: string[]
  formatVariantRefs: string[]
  lineageRefs: string[]
  createdAt: string
}
```

## 7. PlanSource

```ts
interface PlanSource {
  id: string
  sourceAssetId: string
  derivativeId?: string
  role: 'primary' | 'alternate' | 'screen' | 'reaction' | 'broll' | 'evidence' | 'synthetic' | 'audio'
  sourceFps: number
  durationSourceFrames: number
  timebase: { numerator: number; denominator: number }
  sourceToNormalizedMapId?: string
  syncMapId?: string
  rightsSnapshotId: string
  checksum: string
}
```

Compiler falha se checksum/rights snapshot não corresponder ao plano.

## 8. Tracks e overlap policy

```ts
interface BaseTrack {
  id: string
  order: number
  enabled: boolean
  locked: boolean
  clips: TimelineClip[]
}
```

### 8.1 VideoTrack

- `exclusive`: um clip visível por frame; usado no vídeo base.
- `composite`: overlaps permitidos com layouts/masks.
- `alternate`: angle disponível, mas compiler escolhe somente quando referenciado por base switch.

### 8.2 OverlayTrack

Overlaps permitidos se z-order e collision policy validarem.

### 8.3 SubtitleTrack

Uma cue ativa por style lane, exceto composição explicitamente multi-caption. Word timings monotônicos.

### 8.4 AudioTrack

Overlaps permitidos. MixPlan controla prioridade, ducking e gain.

### 8.5 EffectTrack

Efeitos componíveis por registry. Conflitos de transformação devem ter regra de composição ou falhar.

## 9. TimelineClip

```ts
interface TimelineClip {
  id: string
  sourceId: string
  sourceRange: { startFrame: number; endFrame: number }
  timelineRange: { startFrame: number; endFrame: number }
  playbackRate: number
  role: string
  linkedGroupId?: string
  sourceSyncRef?: string
  cropPlanId?: string
  colorPlanId?: string
  transitionIn?: TransitionRef
  transitionOut?: TransitionRef
  opacity?: number
  audioPolicy?: 'use' | 'mute' | 'sync-only'
  metadata?: Record<string, unknown>
}
```

### 9.1 Duração

Para clip linear sem freeze/reverse:

```text
timelineDuration ≈ sourceDuration / playbackRate
```

Erro de arredondamento máximo: 1 frame, resolvido pelo compiler e registrado.

### 9.2 Handles

Transição só pode consumir frames disponíveis antes/depois do source range. Caso contrário, reduzir transição ou falhar conforme policy; nunca ler frame inexistente.

## 10. EditorialTimeline

Representa decisões de narrativa sem detalhes de canvas:

- StoryBlock order;
- selected MediaSegments;
- source ranges;
- cold open/replay;
- coverage de prova/CTA;
- protected narrative units.

Reorder cria novos timeline ranges, preservando source ranges.

## 11. LocaleVariantPlan

```ts
interface LocaleVariantPlan {
  id: string
  locale: string
  baseEditPlanId: string
  localizedScriptId: string
  speechAudioAssetId?: string
  alignmentId: string
  durationFrames: number
  timelinePatches: TimelinePatch[]
  subtitleTrack: SubtitleTrack
  syntheticAssetRefs: string[]
}
```

Mudança de duração recompila clips dependentes de fala. B-roll pode estender, encurtar ou trocar; não usar timestamps antigos.

## 12. FormatVariantPlan

```ts
interface FormatVariantPlan {
  id: string
  outputSpecId: string
  basePlanId: string
  localeVariantId?: string
  canvas: { width: number; height: number }
  safeArea: NormalizedInsets
  layoutSegments: ResponsiveLayoutSegment[]
  cropPlans: CropPlan[]
  elementPlacements: ElementPlacement[]
  formatPatches: TimelinePatch[]
  qualityStatus: 'pending' | 'valid' | 'invalid'
}
```

## 13. Coordenadas e layout

- Coordenadas normalizadas `[0,1]` no canvas.
- Bounds não podem depender do tamanho do player.
- Safe areas pertencem ao OutputSpec/DeliveryProfile.
- Placement pode referenciar semantic anchors: face, screen, focal point, thirds.
- CropPlan registra tracking target, key samples e fallback.

## 14. Command versus Patch

**Command:** intenção de usuário/IA.  
**Patch:** alteração concreta resolvida contra versão base.

```ts
interface EditCommand<T = unknown> {
  id: string
  baseVersionId: string
  author: { type: 'user' | 'director' | 'system'; id: string }
  type: CommandType
  scope: EditScope
  payload: T
  reason?: string
  idempotencyKey: string
  createdAt: string
}

interface ResolvedPatch {
  commandId: string
  operations: PatchOperation[]
  expectedBaseHash: string
  invalidationPreview: InvalidationSet
}
```

## 15. Command catalog mínimo

### Estrutura

- AddClip, RemoveClip, ReplaceClip.
- TrimClip, SplitClip, MoveClip.
- ReorderStoryBlock.
- DuplicateRange/ColdOpen.
- ChangeCameraAngle.

### Visual

- SetLayout, SetCrop, SetPlacement.
- Add/RemoveOverlay.
- SetMovement, SetEffect.
- SetColorPlan, SetLut.

### Texto/legenda

- UpdateOverlayText.
- SetSubtitleStyle.
- UpdateSubtitleText.
- SetSubtitleAnchor.
- HideSubtitleRange.

### Áudio

- ReplaceSpeechAudio.
- SetGain/Ducking/Music/SfxEvent.

### Governança

- Protect/Unprotect.
- ResolveAnnotation.
- Add/RemoveOutputSpec.
- Add/RemoveLocale.

Cada command possui payload schema e validator próprios.

## 16. EditScope

```ts
interface EditScope {
  project?: true
  storyBlockId?: string
  trackId?: string
  clipIds?: string[]
  frameRange?: { startFrame: number; endFrame: number }
  locale?: string
  outputSpecIds?: string[]
  applyToAllFormats?: boolean
  applyToAllLocales?: boolean
  recipeIds?: string[]
}
```

### 16.1 Regras

- UI default: locale e formato visíveis.
- `all` exige confirmação quando invalidação/custo exceder threshold.
- Scope vazio é inválido.
- Scope ambíguo retorna preview, não aplica.
- Command global não pode sobrescrever override específico sem flag explícita.

## 17. Resolução transacional

```text
receive command
→ load exact baseVersion
→ idempotency lookup
→ permission/policy/protected checks
→ resolve semantic targets
→ build patch in memory
→ validate invariants
→ compute dependency/invalidation set
→ estimate cost/jobs
→ persist command + new version + diff atomically
→ enqueue jobs after commit
```

Se enqueue falhar, versão permanece com artifacts `stale` e outbox retry; nunca reverte silenciosamente a edição.

## 18. ProjectVersion

```ts
interface ProjectVersion {
  id: string
  projectId: string
  sequence: number
  parentVersionId?: string
  forkedFromProjectId?: string
  forkedFromVersionId?: string
  snapshotRefs: {
    brief?: string
    treatment?: string
    story?: string
    editPlan: string
    policies: string
  }
  baseHash: string
  createdBy: string
  createdAt: string
}
```

Versions formam DAG por forks, mas sequência é linear dentro de cada projeto.

## 19. Undo, redo e restore

- Undo não apaga; cria versão com patch inverso ou snapshot anterior.
- Redo reaplica Command contra nova base, revalidando.
- Restore cria versão cujo conteúdo referencia snapshot escolhido.
- Job/asset gerado por versão abandonada permanece cacheável se rights/policy permitirem.

## 20. Fork copy-on-write

### Copiar por referência

- masters e derivatives;
- MediaSegments;
- Treatment/Story/EditPlan snapshots;
- Brand/policy snapshots;
- provider artifacts reutilizáveis.

### Não copiar

- aprovação/publicação;
- external campaign IDs;
- performance metrics;
- comments resolvidos como novos;
- current job ownership.

Fork inicia `draft`, com outputs `stale` ou referenciados como preview histórico, nunca “aprovado”.

## 21. Protected elements

```ts
interface ProtectedElement {
  id: string
  target: { type: 'clip' | 'range' | 'text' | 'asset' | 'storyBlock' | 'decision'; id: string }
  scope: EditScope
  reason?: string
  createdBy: string
  allowExplicitUserOverride: boolean
}
```

Conflito de patch retorna `PROTECTED_TARGET` com targets afetados e alternativas não destrutivas quando disponíveis.

## 22. Concorrência

### 22.1 Optimistic concurrency

Command exige `baseVersionId` e `baseHash`.

- Match: processar.
- Mismatch sem overlap: oferecer rebase automático com preview.
- Mismatch com mesmo target/range: conflict manual.

### 22.2 Jobs stale

Job carrega `originVersionId`. Ao concluir:

- Se versão ainda é dependente do job: attach.
- Se não: salvar artifact no cache/lineage, não alterar projeto.

### 22.3 Batch annotations

Annotations independentes podem virar um PatchSet atômico. Se uma falhar, policy define `all-or-nothing` por default.

### 22.4 Patch automático individual

Uma annotation aberta é interpretada em uma proposta persistida e vinculada à `baseVersionId`; ela nunca autoriza escrita livre no `EditPlan`. O vocabulário permitido é fechado em `trim`, `replace-asset`, `update-text`, `update-layout`, `update-subtitle` e `move`. Valores e targets são validados por operação antes de qualquer alteração.

A proposta passa, nesta ordem lógica, pelos gates de ambiguidade, elementos protegidos, policy e budget. Enquanto um gate falhar, ela não pode criar Command nem versão. Uma proposta pronta inclui custo estimado, ranges e artifacts invalidados, targets alterados e delta de qualidade esperado. A aplicação exige confirmação humana/API explícita e chave idempotente; cria um Command `apply-review-patch`, um snapshot e uma ProjectVersion filha imutável, além do compare antes/depois. O render é assíncrono e seu sucesso ou erro permanece associado à proposta.

## 23. Dependency graph

### 23.1 Tipos de nós

Master, derivative, transcript, alignment, perception, treatment, story, assetBrief, providerArtifact, EditPlan, LocalePlan, FormatPlan, RenderInput, proxy, final.

### 23.2 Edge

```ts
interface DependencyEdge {
  fromArtifactId: string
  toArtifactId: string
  dependencyType: 'content' | 'timing' | 'visual' | 'audio' | 'policy' | 'rights'
  invalidationRule: 'always' | 'if-hash-changed' | 'scope-dependent'
}
```

### 23.3 Algoritmo de invalidação

1. Identificar nodes diretamente alterados.
2. Traversal downstream por edge rule.
3. Filtrar por scope locale/format/recipe.
4. Marcar artifacts `stale` com reason/commandId.
5. Deduplicar jobs por content hash.
6. Estimar custo e apresentar quando necessário.

## 24. Matriz de invalidação

| Command | Invalida | Não invalida |
|---|---|---|
| SetSubtitleStyle em 9:16 | FormatPlan/RenderInput/proxy/final 9:16 | ASR, outros formatos |
| UpdateSubtitleText | SubtitleTrack downstream; alignment se timing mudou | vídeo/áudio se texto visual apenas |
| ReplaceSpeechAudio sintético | alignment, avatar/lipsync, locale/edit/render dependentes | outros blocks/locales |
| ReplaceClip por asset existente | EditPlan downstream no scope | percepção global, provider generation |
| SetCrop 1:1 | FormatPlan e renders 1:1 | demais ratios |
| SetLut global | color derivatives e todos outputs no scope | TTS/avatar/story |
| ChangeObjective | treatment/story/edit/critics/renders | masters, ingest, transcript |
| AddLocale | localization/audio/alignment/locale/format/renders | source story e outputs existentes |
| ReorderStoryBlock | editorial timeline, EditPlan, subtitle/audio timing/renders | masters e catalog |
| UpdateBrandLogo | placements/renders que usam logo | mídia principal e story |

## 25. Diff semântico

```ts
interface VersionDiff {
  commands: string[]
  storyChanges: DiffItem[]
  timelineChanges: DiffItem[]
  visualChanges: DiffItem[]
  audioChanges: DiffItem[]
  outputChanges: DiffItem[]
  invalidatedArtifacts: string[]
  estimatedCostDelta: number
}
```

UI não deve mostrar JSON diff como experiência principal.

## 26. Migrations

```ts
interface PlanMigration {
  fromVersion: number
  toVersion: number
  migrate(input: unknown): unknown
  validate(output: unknown): void
}
```

Regras:

- função pura;
- fixture antes/depois;
- nenhuma migration implícita no renderer;
- manifest preserva versão original;
- downgrade não é obrigatório, mas restore do artifact original é.

## 27. Compiler boundary

Compiler recebe planos/snapshots já resolvidos e produz RenderInput autocontido:

- URLs assinadas/resolvidas;
- clips frame-first;
- layouts/crops;
- subtitles;
- effects;
- mix;
- output settings;
- checksums.

Renderer não chama provider, DB, Director ou busca de biblioteca.

## 28. Validation errors

| Código | Condição | Ação |
|---|---|---|
| INVALID_RANGE | end≤start/out-of-source | rejeitar command |
| TRACK_OVERLAP | overlap viola policy | rejeitar ou resolver se command prevê |
| SOURCE_MISSING | asset/derivative ausente | blocked/stale |
| RIGHTS_INVALID | snapshot não autoriza | bloquear attach/render |
| PROTECTED_TARGET | patch toca protegido | rejeitar target |
| VERSION_CONFLICT | base stale | rebase/compare |
| FORMAT_SCOPE_REQUIRED | edição visual ambígua | pedir scope |
| MIGRATION_MISSING | schema não suportado | bloquear render |
| HANDLE_INSUFFICIENT | transição sem frames | reduzir/falhar por policy |

## 29. Observabilidade

- command rate/failure;
- version creation latency;
- conflict/rebase rate;
- invalidation fan-out;
- jobs evitados por cache;
- stale artifacts;
- migration failures;
- render input hashes;
- protected conflicts;
- fork/storage savings.

## 30. Cenários Given/When/Then

### EP-01 — Crop específico

**Given** outputs 9:16 e 16:9  
**When** usuário altera crop apenas em 9:16  
**Then** somente FormatPlan/renders 9:16 ficam stale.

### EP-02 — Command concorrente

**Given** dois usuários na versão 5  
**When** ambos editam o mesmo subtitle  
**Then** primeiro cria v6; segundo recebe conflict e diff, sem overwrite.

### EP-03 — Job antigo

**Given** avatar job originado em v3 e projeto já está em v5 sem aquele bloco  
**When** job conclui  
**Then** artifact é salvo no cache, mas não anexado à v5.

### EP-04 — Fork

**Given** projeto concluído com masters grandes  
**When** usuário duplica  
**Then** novo projeto referencia masters, inicia draft e não copia publicação.

### EP-05 — Protected

**Given** CTA protegido  
**When** Diretor tenta encurtar  
**Then** command falha para esse target e alternativa preservadora é sugerida.

### EP-06 — Reorder

**Given** trecho 40–45s vira cold open  
**When** plan compila  
**Then** source range permanece, timeline recebe cópia/ordem, subtitles são remapeadas sem editar source.

### EP-07 — Undo

**Given** v8 trocou B-roll  
**When** usuário desfaz  
**Then** v9 referencia escolha anterior e mantém v8 no histórico.

### EP-08 — Migration

**Given** fixture schema v2 e renderer v3  
**When** migration registrada executa  
**Then** output valida e golden RenderInput permanece equivalente.

## 31. Critérios de aceite

1. Todas as operações passam por Command/Patch.
2. Invariantes de range são property-tested.
3. Scope impede vazamento entre formatos/locales/receitas.
4. Fork é copy-on-write comprovado por storage refs.
5. Concorrência nunca causa lost update.
6. Job stale nunca altera versão atual.
7. Invalidation set é explicável e testado.
8. Undo/restore preservam audit trail.
9. Compiler/renderer funcionam sem DB.
10. Migration ausente falha explicitamente.
11. Rights e protected são gates.
12. Diff mostra impacto/custo sem JSON bruto.
13. Transição nunca lê frame fora da fonte.
14. Locale timing não reutiliza alignment original.
15. Cada RenderArtifact registra plan/input hash.

## 32. Questões para ADR

- Estrutura física de snapshots e JSONB versus tabelas normalizadas.
- Estratégia de outbox/queue após commit.
- Biblioteca de schema validation.
- Semântica de rebase automático.
- Persistência/consulta eficiente do dependency graph.
- Granularidade de versions em batch edits.
