# Spec 07 — UX do Editor, Timeline e Revisão

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **Referências visuais:** `docs/assets/apollo-v2-editor-reference.png`, `docs/assets/apollo-v2-workspace-reference.png`

## 1. Objetivo

Definir a experiência IA-first com edição manual, revisão contextual, versões e jobs visíveis. A UI deve permitir controlar o Apollo sem exigir conhecimento de prompts ou do schema interno.

## 2. Princípios

1. Preview e timeline representam a mesma ProjectVersion.
2. Toda edição explicita escopo.
3. Ação cara mostra impacto/custo antes.
4. IA explica decisão e permite protect/replace.
5. Falha é localizada e recuperável.
6. Não esconder status de proxy/final/stale.
7. Não copiar complexidade integral de NLE profissional no MVP.
8. Ações manuais e IA usam Commands iguais.

## 3. Invariantes de experiência e consistência

1. O frame exibido, a timeline, o inspector e o `RenderElementMap` devem apontar para a mesma `ProjectVersion` e para o mesmo hash de proxy.
2. Nenhuma mutação pode ser confirmada sem `scope` explícito; o sistema nunca presume “todos os formatos”, “todos os idiomas” ou “todas as recipes”.
3. Toda operação destrutiva, paga, demorada ou de grande alcance exige `ImpactPreview` antes do commit.
4. O estado visual corrente deve ser distinguível de sugestão, processamento pendente, resultado stale e erro.
5. Undo, redo, restore e aplicação de annotation criam Commands/versões; não alteram silenciosamente histórico já persistido.
6. Elementos protegidos não podem ser modificados por gesto, command em linguagem natural ou ação em lote sem desbloqueio autorizado.
7. Um job concluído para versão anterior nunca pode substituir o proxy ou render atual.
8. Falha parcial deve preservar edições confirmadas e identificar exatamente quais ranges, variants ou recipes não foram atualizados.
9. A interface não apresenta percentual inventado: quando o provider não informa progresso, mostra fase e estado indeterminado.
10. Acessibilidade por teclado, foco e leitura de estado deve permanecer funcional mesmo quando painéis forem colapsados.

## 4. Information architecture

### Workspace

- Projetos.
- Produção em lote.
- Biblioteca.
- Apresentadores IA.
- Marca e segurança.
- Configurações.

### Editor

- media rail;
- preview;
- Director panel;
- timeline;
- inspector;
- review/issues;
- history/versions;
- jobs/render.

## 5. Modos do editor

| Modo | Objetivo | Alterações |
|---|---|---|
| View | assistir/inspecionar | não |
| Edit | manipular timeline/props | sim |
| Review | anotar/aplicar correções | sim via annotations |
| Compare | antes/depois/versões | não até escolher restore |
| Batch | editar recipes em escopo | sim com impact preview |

Troca de modo preserva playhead/selection quando possível.

## 6. Layout desktop

- Sidebar fixa 200–240px.
- Media rail redimensionável/colapsável.
- Preview central preserva aspect ratio.
- Director/Inspector right panel 360–440px.
- Timeline inferior redimensionável 240–520px.
- Em viewport insuficiente, painéis colapsam; timeline/preview nunca sobrepõem controles críticos.

## 7. Project header

Exibe:

- nome/versão/status;
- objetivo;
- recipe;
- locale;
- output format;
- proxy/final/stale;
- job progress;
- undo/redo;
- render/export.

Mudança de locale/formato troca variant visível, não edita automaticamente.

## 8. Timeline data model na UI

UI recebe view model, não EditPlan bruto:

```ts
interface TimelineViewModel {
  versionId: string
  fps: number
  durationFrames: number
  tracks: TimelineTrackView[]
  playheadFrame: number
  selection: TimelineSelection
  markers: TimelineMarkerView[]
  staleRanges: FrameRange[]
}
```

## 9. Tracks MVP

- vídeo base/câmeras;
- captura de tela;
- áudio principal;
- B-roll/inserts;
- overlays/texto;
- legendas;
- efeitos/cor;
- annotations/issues.

Track possui visibility, mute, lock, height e color semântica. Lock de UI não substitui ProtectedElement de domínio; opção “proteger” cria ambos.

## 10. Seleção

- Click clip: seleciona clip.
- Shift-click: adiciona/remove seleção.
- Drag em vazio: range selection.
- Click track header: seleciona track context, não clips.
- Escape: limpa seleção.
- Double-click: abre inspector detalhado/source.
- Click preview: hit-test layer e sincroniza seleção na timeline.

Seleção sempre mostra breadcrumb: Project → Recipe → Locale → Format → Track → Clip/Range.

## 11. Playhead e seek

- Space play/pause.
- Setas: ±1 frame.
- Shift+setas: ±1 beat/marker configurado.
- Click ruler: seek.
- Drag playhead: scrub com thumbnails/áudio opcional.
- Timecode editável aceita `hh:mm:ss:ff`.
- Player mostra dropped preview frames sem alterar timecode lógico.

## 12. Zoom e scroll

- Wheel vertical scroll tracks.
- Shift+wheel horizontal.
- Ctrl/Cmd+wheel zoom centrado no cursor/playhead.
- +/- zoom.
- Fit timeline.
- Min zoom mostra minutos; max mostra frames.

Virtualização deve manter selection/playhead estáveis.

## 13. Snapping

Targets:

- playhead;
- clip edges;
- subtitle/word boundaries;
- beats/markers;
- scene boundaries;
- sync anchors;
- protected range edges.

Default tolerance visual: 8px convertida para frames no zoom atual. Alt/Option desativa temporariamente. UI mostra linha/label do target. Snapping não pode mover source range sem preview do novo timing.

## 14. Trim, split e move

### Trim

- Drag handle altera source/timeline range conforme clip type.
- Tooltip mostra source e timeline time.
- Handles insuficientes limitam drag.
- Ripple trim é modo explícito; default non-ripple no MVP.

### Split

- S ou menu no playhead.
- Não permitir fora do clip ou em frame protegido.
- Linked audio/video split juntos por default; opção unlink explícita.

### Move

- Drag com ghost preview.
- Drop inválido mostra razão antes de soltar.
- Base exclusive track não aceita overlap sem command de replace/transition.
- Reorder narrativo de bloco deve avisar impacto em subtitles/áudio/variants.

## 15. Inspector

Seções conforme target:

- Source e lineage.
- Range/timing.
- Layout/crop/placement.
- Texto/legenda.
- Cor/LUT.
- Movimento/efeitos.
- Áudio.
- Rights/consent.
- Quality issues.
- Protect.
- Replace/regenerate.

Campos mostram origem: default, workspace, Director, user override. “Reset” volta ao nível anterior, não a valor arbitrário.

## 16. Preview

- canvas do output atual;
- safe areas e grid opcionais;
- layer bounds no hover/select;
- quality issue overlays;
- annotation regions;
- proxy quality indicator;
- render watermark interno opcional;
- frame/timecode;
- before/after toggle.

Preview de baixa qualidade deve dizer resolução/fps e não ser confundido com final.

## 17. RenderElementMap

Por frame, elementos fornecem id/type/bounds/z-index/source/scene/clip e hit-test priority. Elementos transparentes não capturam clique fora da área visível. Se múltiplos overlaps, abrir chooser ou ciclar com Tab.

## 18. Annotation flow

1. Pause automático ao iniciar anotação.
2. Click pontual ou drag retângulo.
3. Capturar frame, screenshot e crop.
4. Resolver layer/scene/clip.
5. Usuário escreve instrução.
6. Escolhe scope e formatos/locales.
7. Salva como open.
8. Pode acumular.
9. “Aplicar correções” compila PatchSet/impact preview.
10. Nova versão renderiza range/proxy afetado.
11. Usuário aceita/reabre/reverte.

## 19. Escopos de annotation

- this frame;
- marked region;
- current clip;
- current scene/story block;
- selected time range;
- whole project;
- current/all formats;
- current/all locales;
- selected recipes.

Default: cena/clip identificado + formato/locale atual. Global exige seleção explícita.

## 20. Annotation states

open → interpreted → impact-ready → applying → applied → resolved.

Alternativas: needs-clarification, rejected, failed, reopened, superseded.

Applied não significa resolved; resolução ocorre após preview/aceite ou auto-policy.

## 21. Diretor panel

### Plano

- objetivo/rubrica;
- TreatmentPlan;
- StoryPlan;
- assumptions/conflicts;
- budget/custo;
- decisions com confidence.

### Revisão

- QualityIssues;
- annotations;
- proposed patches;
- before/after score;
- apply/reject/protect.

### Histórico

- versions;
- commands/diffs;
- jobs/providers;
- renders;
- costs;
- restore/fork.

## 22. Manual versus IA

- Usuário pode editar diretamente ou instruir em linguagem natural.
- Direct action ganha precedência na versão criada.
- “Refazer etapa” lista o que será invalidado e custo.
- IA não modifica seleção manual protegida.
- Sugestão não aplicada deve ser visualmente distinta de estado atual.

## 23. Batch UX

Ao entrar em Batch mode, banner fixo mostra scope e quantidade. Antes do commit:

- recipes afetadas;
- outputs;
- differences que podem quebrar experimento;
- jobs/custo;
- conflitos/protected;
- opção all-or-nothing ou skip failures quando permitido.

Nunca reutilizar seleção batch invisível ao voltar ao editor individual.

## 24. Dashboard de projetos

Cards mostram status real, percentuais baseados em steps/items, quality, outputs, comments e quick actions. Falha mostra etapa e ação. Concluído não significa publicado. Filtros e busca persistem na sessão do usuário.

## 25. Versões e compare

- Compare split/overlay/toggle.
- Sincronizar playhead entre versões quando timelines compatíveis.
- Mostrar diff semântico ao lado.
- Restore cria nova versão.
- Version stale banner aparece se outro command foi aplicado.

## 26. Conflict UX

Quando baseVersion diverge:

- mostrar mudanças remotas;
- auto-rebase somente sem target overlap;
- opções: rebase, descartar, duplicar como fork;
- nunca overwrite silencioso.

## 27. Estados de jobs

Cada operação longa mostra queued/running/progress/waiting-provider/retrying/failed/canceled/completed. Progress indeterminado não usa percentual falso. Cancelamento informa artifacts preservados e etapas não reversíveis.

## 28. Error design

Erro contém:

- o que falhou;
- etapa/source/provider;
- impacto;
- retryability;
- ação recomendada;
- diagnóstico técnico recolhível;
- link ao job/log para admin.

## 29. Acessibilidade

- WCAG AA como alvo.
- Focus visível e ordem lógica.
- Atalhos documentados/remapeáveis posteriormente.
- Cor nunca é único indicador.
- Targets ≥ 32px desktop.
- Screen reader labels para controls.
- Reduced motion na UI.
- Captions/transcript para preview.

## 30. Performance budgets iniciais

- Interação timeline local: resposta visual <100ms.
- Seek para proxy cacheado: p95 <500ms em rede local adequada.
- Abrir projeto: shell <2s; metadata incremental.
- 1.000 clips: timeline virtualizada sem renderizar todos DOM nodes.
- Scroll/drag alvo 60fps; degradar thumbnails antes de input latency.

## 31. Atalhos MVP

Space play; setas frame; Shift+setas beat; S split; Delete remove; Cmd/Ctrl+Z/Y; M annotation; P protect; +/- zoom; F fit; Esc clear; Tab cycle layers.

## 32. Observabilidade e métricas de UX

Cada evento deve carregar `workspaceId`, `projectId`, `versionId`, `userId`, `sessionId`, `surface`, `commandId` quando aplicável, locale/formato ativos e timestamp monotônico no cliente. Texto livre de annotations, prompts, transcrições e URLs assinadas não entram em analytics; logs técnicos recebem apenas identificadores, enums, duração e códigos de erro.

Eventos mínimos:

| Evento | Campos específicos | Uso |
|---|---|---|
| `editor_opened` | tempo até shell, metadata e primeiro frame | medir carregamento percebido |
| `timeline_interaction` | ação, duração, quantidade de clips, dropped frames | latência de trim/move/seek |
| `impact_preview_opened` | command type, targets, estimated jobs/cost | verificar compreensão de alcance |
| `command_committed` | origem manual/IA, scope, optimistic result | adoção e confiabilidade |
| `command_conflict` | overlap, resolution escolhida | lost-update prevention |
| `annotation_created` | scope, target type, possui região | qualidade do fluxo de revisão |
| `annotation_resolved` | rounds, tempo aberto, accepted/reopened | retrabalho |
| `job_status_viewed` | estado, ação tomada | clareza operacional |
| `accessibility_action` | keyboard/pointer, shortcut | cobertura de teclado sem identificar conteúdo |

Métricas e alertas iniciais:

- p50/p95 de interação local, seek, primeiro frame e commit;
- taxa de commands revertidos em até cinco minutos;
- taxa de conflicts, auto-rebase e forks;
- annotations reabertas e rounds até resolução;
- jobs com estado indeterminado por mais que o SLA da fase;
- erro de hash entre preview e timeline: alvo zero, alerta imediato;
- stale job aplicado: alvo zero, incidente crítico;
- cobertura automatizada dos fluxos principais somente por teclado.

O painel interno deve permitir filtrar por build da UI, navegador, capacidade do dispositivo, tamanho do projeto e tipo de proxy. Performance budgets são avaliados em datasets pequenos, médios e no fixture de 1.000 clips.

## 33. Cenários Given/When/Then

### UX-01 — Annotation na legenda

**Given** preview pausado e subtitle visível  
**When** usuário marca a região  
**Then** hit-test seleciona subtitle, scope default é cena+formato atual e screenshot é salvo.

### UX-02 — Crop por formato

**Given** 9:16 ativo  
**When** usuário reposiciona o rosto  
**Then** impact preview mostra somente 9:16 salvo escolha all formats.

### UX-03 — Job sem percentual

**Given** provider não fornece progress  
**When** job processa  
**Then** UI mostra fase/tempo/status indeterminado, não “50%”.

### UX-04 — Conflito

**Given** outro usuário alterou mesmo clip  
**When** command local é enviado  
**Then** UI mostra conflict/diff; nenhuma mudança é perdida.

### UX-05 — Batch

**Given** 12 recipes selecionadas  
**When** usuário troca CTA  
**Then** banner/impact/custo são exibidos antes do commit.

### UX-06 — Protected

**Given** clip protegido  
**When** usuário tenta trim  
**Then** UI explica proteção e oferece desbloqueio autorizado.

## 34. Critérios de aceite

1. Preview/timeline usam mesma version/hash.
2. Toda edição mostra e persiste scope.
3. Timeline suporta seleção, trim, split, move e snapping definidos.
4. Hit-test resolve layers ou oferece chooser.
5. Annotation salva frame/região/contexto/screenshot.
6. Applied versus resolved são estados distintos.
7. Compare/restore preservam histórico.
8. Conflict nunca causa lost update.
9. Jobs mostram progresso honesto e ação de erro.
10. Batch edit apresenta impacto/custo.
11. Protected é visível e respeitado.
12. UI funciona por teclado nos fluxos principais.
13. Performance budgets possuem medição automatizada.
14. Mockups aprovados orientam visual/hierarquia.

## 35. Questões para design/ADR

- Framework de timeline/canvas.
- Estratégia de optimistic updates.
- Streaming de job events.
- Colaboração simultânea futura.
- Component library/design tokens.
- Persistência de layout de painéis por usuário.
