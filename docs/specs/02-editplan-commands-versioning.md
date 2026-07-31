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

### 22.5 Batch review integrado

Um lote aceita de duas a cem propostas `ready`, sem duplicatas, ligadas a annotations abertas e à mesma `baseVersionId` corrente. Cada proposta deve resolver exatamente uma operação tipada; gates individuais continuam sendo precondição e nunca são recalculados ou contornados pelo lote.

O compilador agrupa operações por `targetId`:

- assinaturas idênticas são deduplicadas no `PatchSet`;
- assinaturas divergentes tornam todos os participantes conflitantes e registram IDs pares;
- `all-or-nothing`, default, devolve patch nulo e `rolled-back` para todos os itens;
- `partial-retry`, somente quando pedido explicitamente, inclui os itens seguros e mantém conflitantes `retryable`;
- lote sem item seguro nunca é aplicável.

A aplicação exige `confirmed: true`, `Idempotency-Key` e aprovação humana para uso como agent tool. Uma transação serializável cria exatamente um Command `apply-review-patch-batch`, um snapshot, uma ProjectVersion filha, o compare e o evento de outbox; move somente annotations/propostas incluídas para `applied`. Mudança concorrente em versão, annotation ou proposta aborta toda a transação. Após commit, uma operação durável de proxy é vinculada ao lote. Replay com a mesma chave e fingerprint reconstrói o mesmo resultado; chave reutilizada com outro payload falha.

### 22.6 Edição manual integrada

`GET /v1/projects/{projectId}/timeline` projeta o `EditPlan v2` compilado corrente em um view model imutável com `versionId`, `revision`, clips, track index e snap points. Essa projeção não é fonte de verdade e pode ser reconstruída a qualquer momento pelo snapshot.

`POST /v1/projects/{projectId}/manual-edits` aceita:

- `action=apply` com uma operação fechada `trim`, `split`, `move`, `replace`, `crop` ou `inspect`;
- `action=undo` com o pai direto como `targetVersionId`;
- `action=redo` com uma versão compilada do mesmo projeto como `targetVersionId`;
- `action=restore` quando o compare escolhe um snapshot histórico para criar uma nova versão corrente.

O envelope exige `baseVersionId`, `baseHash`, `expectedRevision`, `variantId`, `targetId` e `Idempotency-Key`. `scope.clipIds` registra o target e `scope.outputSpecIds` registra a variante. Uma transação serializável cria Command `manual-edit`, novo snapshot, versão filha, compare e outbox; o `currentVersionId` avança por compare-and-swap. Falha ou corrida não deixa versão, snapshot, Command ou evento parcial.

`crop` recebe exatamente `{x,y,width,height}` normalizados, positivos e
inteiramente contidos no source frame. O handler grava o retângulo no clip do
snapshot novo e classifica o impacto como `changeKinds=[crop]`, dependência
`visual`, um range correspondente ao clip e somente o `variantId` do envelope.
A timeline/API e a UI expõem esse estado persistido; o renderer converte o
retângulo para pixels pares da fonte materializada antes de scale/composição.
Não existe interpretação de string de layout como crop.

Undo/redo clonam o conteúdo do snapshot escolhido, atribuem nova identidade de EditPlan/ProjectVersion e registram `restoresVersionId`. A versão restaurada nunca se torna mutável e nenhuma linha histórica é removida. Após commit, a mesma rota enfileira um proxy durável preso à nova versão.

### 22.7 Compare version-bound

`GET /v1/projects/{projectId}/version-comparisons` exige `beforeVersionId`, `afterVersionId` e `mode=toggle|split|overlay`. As duas versões são resolvidas no mesmo workspace/projeto e seus snapshots de `EditPlan v2` são comparados. O resultado inclui:

- duração antes/depois e delta em milissegundos;
- `mappingId` e `playheadMapping=shared|independent`;
- score antes/depois e delta;
- issues adicionadas/resolvidas;
- mudanças semânticas limitadas de timeline, source, inspector, composição, legendas e duração;
- `versionsPreserved=true`.

Um mapping só é `shared` quando ambos os snapshots possuem a mesma identidade explícita. Duração semelhante, clip ID semelhante ou ausência de mapping não autoriza sincronismo inferido.

`POST /v1/projects/{projectId}/version-comparisons` aceita `accept`, `reopen` e `restore`. O envelope inclui as duas versões, modo, `baseVersionId`, `baseHash`, `expectedRevision`, `variantId` e `Idempotency-Key`.

- `accept` e `reopen` exigem que `afterVersionId` seja a versão corrente; uma transação serializável cria Command `compare-action`, altera apenas o status do projeto por compare-and-swap e grava `project.status.changed` na outbox;
- `restore` executa o mesmo handler `manual-edit` com `action=restore`, cria snapshot e ProjectVersion filha, mantém A/B intactas e enfileira proxy durável;
- replay da mesma chave/fingerprint devolve o mesmo Command/versão;
- chave reutilizada com outro payload ou base stale falha sem escrita parcial.

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

### 23.4 Contrato persistido de impacto

Cada handler integrado deve persistir com o próprio `Command` um
`command-impact/v1` content-addressed. O contrato liga `commandId`, versão-base
e versão-resultado e declara, sem paths de storage:

- tipos de mudança e dependência (`content`, `timing`, `visual`, `audio`,
  `policy`, `rights`);
- ranges frame-first afetados;
- variants/formats afetados;
- artifacts proxy/final concluídos da versão-base que ficam stale;
- render proxy mínimo esperado, separado do enqueue efetivo.

O conjunto de outputs deve ser relido dentro da mesma transação serializável
que grava `V2EditCommand` e `ProjectVersion`; drift aborta o commit. Artifacts
históricos continuam imutáveis e disponíveis para leitura da versão antiga:
"stale" é relação com a nova versão, não corrupção nem remoção dos bytes.
O primeiro adapter integrado cobre `manual-edit`; expandir o mesmo contrato
para Commands editoriais, Diretor, batch e transcript é obrigatório antes de
considerar FR-233 concluído.

Para `manual-edit`, cada output do mapa também cria atomicamente uma relação
normalizada `command-artifact-invalidation/v1`, identificada por hash canônico
e ligada por FK ao Command, à versão-base, à versão-resultado e ao artifact. A
relação carrega `stale`, variant, dependências, ranges e `impactHash`. Nenhuma
linha é criada para seleção sem mudança de render ou para outra variant. O
status global de `V2MediaArtifact` não muda: o artifact continua válido para a
versão que o produziu. A capability aditiva
`apollo.projects.artifact-invalidations.read` devolve as mesmas relações sem
alterar o payload persistido; replay precisa rejeitar qualquer divergência
entre payload e linhas.

O primeiro executor parcial usa o `command-impact/v1` persistido como única
fonte do range: para um `manual-edit` com exatamente um range proxy, ele exige
um proxy concluído da versão-base, valida identidade/hash/tamanho, recompõe só o
trecho e monta a saída completa com prefixo e sufixo ainda válidos. O renderer
recebe paths já materializados e não consulta persistência. Se não houver base
reutilizável ou o range cobrir todo o timeline, o mesmo worker faz render V2
completo. A conclusão cria uma
`V2CommandArtifactInvalidationResolution` imutável ligada à operação e ao novo
artifact/manifest; consultas omitem a invalidação apenas após `succeeded`, de
modo que queda ou retry não declare o stale resolvido antes da hora. O suporte
atual é deliberadamente restrito a um range mesclado e clips em rate 1.

Quando o impacto persistido declara somente `selection`, sem artifacts afetados
e sem render mínimo, o enqueue não materializa um render vazio nem cria bytes.
Ele exige um proxy `succeeded/completed` da versão-base, reutiliza exatamente o
mesmo artifact/manifest e persiste uma `PublicOperation` já concluída com
`reusedFromOperationId`, `reuseCommandId`, `reuseImpactHash` e
`reuseBaseVersionId`. A transação relê a versão corrente, o Command e seu hash,
o proxy-base, a fonte, o artifact e o manifest; também copia os bindings de cor
imutáveis apenas como contexto histórico, sem executar resolução ou renderer.
Ausência ou drift do proxy-base falha fechado. Replays convergem para a mesma
operação e nenhum worker pode reivindicá-la porque ela já nasce terminal.

O caso integrado de crop usa o mesmo executor: o Command tipado materializa o
retângulo no EditPlan, o impacto restringe a variante e o range do clip, e o
renderer preserva crop ao fatiar o input parcial. O golden audiovisual cria
uma fonte com metades vermelha/azul, aplica crop somente ao range central e
confirma pixels azuis nesse trecho entre prefixo/sufixo vermelhos, duração
integral e bounds atualizados no `RenderElementMap`. A identidade do renderer e
das receitas proxy/final muda junto com essa semântica de pixels. Os contratos
de manual edit, timeline e compare avançam para major 2 com novos schema refs;
os refs v1 permanecem imutáveis no catálogo.

Para uma operação contendo somente `inspect.text`, o impacto não usa o range
inteiro do clip por conveniência. A materialização altera exatamente o
primeiro cue sobreposto e o
impacto compara os snapshots antes/depois, exige um único cue modificado e usa
seus `startFrame/endFrame` como range stale. O golden FFmpeg renderiza texto
anterior e revisado em um cue central, confirma pixels diferentes somente no
range recomposto, prefixo/sufixo byte-equivalentes nos frames amostrados,
duração integral e presença do subtitle no `RenderElementMap` apenas durante o
cue.
Se o mesmo patch também carregar layout, estilo, cor, movimento ou áudio, o
impacto volta deliberadamente ao range do clip para não subinvalidar a mudança
combinada.

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
