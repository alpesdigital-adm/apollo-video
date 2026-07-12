# Spec 04 — Produção em Lote, Variações e Compatibilidade

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **PRD relacionado:** FR-080–087, FR-235

## 1. Objetivo

Definir como roteiro e gravações fragmentadas viram takes, como hooks/corpos/provas/CTAs são combinados e como o sistema seleciona um portfólio útil sem executar produto cartesiano cego.

## 2. Invariantes

1. Receita possui lineage completa.
2. Hard incompatibility elimina combinação, independentemente do score.
3. Texto planejado e falado permanecem distintos.
4. Um take pode mapear um ScriptBlock com diferenças registradas.
5. Recipe selection respeita objetivo, budget e diversidade.
6. Alteração compartilhada invalida somente receitas dependentes.
7. Preflight antecede submit de jobs pagos.
8. Batch item falho não perde o restante do lote.
9. Experimento controlado declara exatamente o que varia.
10. Score e razões são persistidos com versão do modelo/regra.

## 3. Modelo

```ts
interface ProductionBatch {
  id: string
  workspaceId: string
  objective: VideoIntentBrief
  scriptDocumentId?: string
  sourceAssetIds: string[]
  scriptBlockIds: string[]
  takeIds: string[]
  recipeIds: string[]
  outputSpecIds: string[]
  budget: BatchBudget
  status: BatchStatus
}
```

## 4. ScriptBlock

```ts
interface ScriptBlock {
  id: string
  role: 'hook' | 'body' | 'proof' | 'objection' | 'bridge' | 'offer' | 'cta'
  plannedText: string
  angle?: string
  promise?: string
  mechanism?: string
  audience?: string
  awarenessStage?: string
  offerId?: string
  desiredAction?: string
  dependencies: BlockDependency[]
  protectedClaims: ClaimRef[]
}
```

## 5. Take

```ts
interface Take {
  id: string
  sourceAssetId: string
  sourceRange: FrameRange
  role: ScriptBlock['role']
  alignedScriptBlockId?: string
  plannedText?: string
  spokenText: string
  deviations: TextDeviation[]
  completenessScore: number
  deliveryScore: number
  technicalScore: number
  editabilityScore: number
  alignmentConfidence: number
  alternateGroupId?: string
}
```

## 6. Script alignment pipeline

```text
parse document/labels
→ transcript source files
→ candidate boundaries por silêncio/retake/semântica
→ monotonic sequence alignment
→ detect alternates/restarts
→ score completeness/deviation
→ create Takes
→ review low-confidence only
```

### 6.1 Score de alinhamento

| Dimensão | Peso |
|---|---:|
| Similaridade semântica | 35 |
| Cobertura lexical | 20 |
| Ordem esperada | 15 |
| Boundary/completude | 15 |
| Duração plausível | 5 |
| Marcadores/labels | 10 |

- ≥ 80: auto-link.
- 60–79: link com warning/review.
- < 60: unassigned take.

Não forçar block quando duas opções têm diferença < 5 pontos; marcar ambíguo.

## 7. TextDeviation

Tipos:

- omission;
- insertion;
- paraphrase;
- number/claim change;
- qualifier change;
- incomplete ending;
- restart;
- off-script.

Number/claim/qualifier change exige review ou policy explícita.

## 8. CompatibilityEdge

```ts
interface CompatibilityEdge {
  fromTakeId: string
  toTakeId: string
  relation: 'hook-body' | 'body-proof' | 'body-cta' | 'proof-cta' | 'bridge'
  valid: boolean
  hardFailures: CompatibilityFailure[]
  score: CompatibilityScore
  reasons: string[]
  ruleVersion: string
}
```

## 9. Hard incompatibilities

| Código | Condição | Exemplo |
|---|---|---|
| OFFER_MISMATCH | oferta diferente sem bridge | hook curso A + CTA serviço B |
| PROMISE_UNDELIVERED | corpo não entrega promessa | hook “3 passos” + corpo com 1 ideia |
| ACTION_MISMATCH | CTA/destino diverge | WhatsApp + “baixe o PDF” |
| AUDIENCE_CONFLICT | públicos contraditórios | iniciante + operação enterprise específica |
| CONTEXT_MISSING | antecedente obrigatório ausente | “esse segundo erro” sem lista |
| CLAIM_CONTRADICTION | números/qualifiers incompatíveis | “7 dias” versus “30 dias” |
| RIGHTS_BLOCK | source sem autorização | depoimento restrito |
| LANGUAGE_BLOCK | locale sem localization | CTA PT em receita EN |
| TEMPORAL_CAUSALITY | ordem altera causalidade | resultado antes de condição indispensável |
| PROTECTED_DEPENDENCY | block protegido não incluído | claim sem disclaimer obrigatório |

## 10. Soft score

Escala 0–100:

| Dimensão | Peso default |
|---|---:|
| Semantic promise/answer | 25 |
| Objective fit | 15 |
| Mechanism continuity | 15 |
| Awareness/audience | 10 |
| Action fit | 10 |
| Linguistic continuity | 10 |
| Emotional/energy continuity | 5 |
| Visual/audio continuity | 5 |
| Duration fit | 5 |

Edge elegível: ≥ 70 e sem hard failure. 60–69 somente com bridge/review. < 60 rejeitado.

## 11. Linguistic continuity

Detectar:

- pronomes sem antecedente;
- enumeração quebrada;
- pergunta sem resposta;
- “por isso” sem causa;
- “como vimos” sem setup;
- mudança de pessoa/tempo verbal;
- duplicação da mesma frase;
- CTA abrupto sem oferta.

Bridge pode resolver apenas quando adiciona contexto verdadeiro e curto; não inventa premissa.

## 12. VariantRecipe

```ts
interface VariantRecipe {
  id: string
  batchId: string
  orderedTakeIds: string[]
  compatibilityEdgeIds: string[]
  objectiveScore: number
  totalScore: number
  estimatedDurationFrames: number
  experimentGroupId?: string
  changedDimensions: string[]
  status: 'candidate' | 'selected' | 'excluded' | 'materializing' | 'ready' | 'failed'
  exclusionReason?: string
}
```

## 13. Recipe generation algorithm

1. Criar graph somente com edges válidas/condicionais.
2. Enumerar caminhos que atendem roles obrigatórios.
3. Aplicar duration e objective constraints.
4. Calcular score de caminho, penalizando weakest edge.
5. Deduplicar semanticamente.
6. Agrupar experimentos controláveis.
7. Selecionar portfólio por qualidade + diversidade + coverage.
8. Aplicar budget/output matrix.

Score de receita não deve ser média simples: `minEdgeScore` abaixo de 70 elimina; depois usar média ponderada + objective score.

## 14. Diversidade e coverage

```ts
interface PortfolioPolicy {
  targetRecipeCount: number
  minHookCoverage: number
  minBodyCoverage: number
  minCtaCoverage: number
  maxRecipesPerSemanticCluster: number
  controlledExperimentRatio: number
}
```

Seleção gulosa inicial:

1. Melhor score global.
2. Próximo maximiza `quality + coverageGain + diversityGain`.
3. Parar em target/budget.

Não sacrificar hard quality threshold para cobrir take ruim.

## 15. Experimentos controlados

Um experiment group deve compartilhar base e declarar variável:

- hook-only;
- CTA-only;
- proof-only;
- edit-treatment;
- format;
- locale.

Receitas do grupo não podem divergir silenciosamente em outras dimensões. Diff automático valida o grupo antes do render.

## 16. Preflight

```ts
interface BatchExecutionPlan {
  theoreticalCombinations: number
  validCandidateCount: number
  selectedRecipeIds: string[]
  excludedByReason: Record<string, number>
  outputCount: number
  newProviderJobs: ProviderJobEstimate[]
  reusedArtifactCount: number
  estimatedCostCents: number
  estimatedDurationSeconds: number
  estimatedStorageBytes: number
  concurrencyPlan: Record<string, number>
  budgetWarnings: string[]
}
```

Submit pago exige preflight baseado na versão atual. Mudança de recipes/output specs invalida preflight.

## 17. Anti-explosão

- Default nunca é “todas as combinações teóricas”.
- Workspace define max recipes/outputs/cost.
- Output matrix é calculada antes de jobs.
- Assets compartilhados são materializados uma vez.
- Recipes abaixo do threshold ficam visíveis como excluídas, não executadas.

## 18. Batch commands e escopo

- selected recipes;
- experiment group;
- recipes containing Take X;
- same lineage segment;
- all selected outputs;
- current format/locale.

UI deve mostrar quantidade de versões, jobs e custo incremental antes de aplicar.

## 19. Invalidação

| Mudança | Efeito |
|---|---|
| editar Take compartilhado | todas recipes que referenciam o take |
| trocar Take em uma recipe | somente recipe/outputs |
| alterar compatibility rule | rescore candidates; não apagar outputs existentes |
| adicionar formato | FormatPlans/renders selecionados |
| mudar objetivo | compatibility/objective/selection e downstream |
| excluir CTA | recipes dependentes ficam invalid |

## 20. State machine

Batch: draft → ingesting → aligning → reviewing-takes → building-graph → preflight-ready → executing → partial/ready/failed/canceled.

Item: queued → planning → materializing → rendering → reviewing → completed/failed/canceled/superseded.

Estado agregado é derivado dos itens, não substitui estado individual.

## 21. Retry e idempotência

- BatchItem possui idempotency key por recipe+output+version.
- Retry retoma última etapa válida.
- Provider artifact compartilhado não é resubmetido.
- Mudança de ProjectVersion torna item superseded.
- Falha de 1/54 não reinicia 53.

## 22. Observabilidade

- alignment confidence distribution;
- hard failure counts;
- recipe score distribution;
- selected/excluded;
- diversity/coverage;
- theoretical versus executed;
- reuse/cache savings;
- cost per recipe/output;
- failure/retry;
- experiment integrity violations.

## 23. Cenários Given/When/Then

### BV-01 — Produto cartesiano

**Given** 6 hooks, 3 bodies e 3 CTAs  
**When** graph é construído  
**Then** 54 é apenas theoretical; somente receitas válidas e selecionadas entram no preflight.

### BV-02 — CTA incompatível

**Given** body de captação e CTA de venda não relacionado  
**When** edge é avaliada  
**Then** ACTION/OFFER mismatch elimina combinação.

### BV-03 — Dois takes

**Given** duas gravações do H2  
**When** ambos alinham ao bloco  
**Then** alternates são preservados e rankeados, não sobrescritos.

### BV-04 — Experimento hook-only

**Given** três recipes do mesmo grupo  
**When** diff detecta CTAs diferentes  
**Then** grupo é inválido até corrigir ou redefinir variável.

### BV-05 — Budget

**Given** matriz gera 810 outputs acima do limite  
**When** preflight executa  
**Then** submit bloqueia e oferece redução por recipes/formats/locales.

### BV-06 — Retry parcial

**Given** uma recipe falha no provider  
**When** retry é solicitado  
**Then** somente item e dependências são retomados.

## 24. Critérios de aceite

1. Alignment não força ambiguidade abaixo do threshold.
2. Claims/números divergentes exigem review.
3. Hard failures são códigos estáveis e testados.
4. Edge/recipe scores têm breakdown e rule version.
5. Top-N mantém threshold mínimo e diversidade.
6. Experiment groups garantem variável isolada.
7. Preflight inclui custo, tempo, storage e cache.
8. Nenhum job pago inicia com preflight stale.
9. Batch item é idempotente e retomável.
10. Alterações compartilhadas invalidam apenas recipes dependentes.
11. Resultado mantém lineage H/B/CTA.
12. Falha parcial não perde outputs concluídos.

## 25. Questões para ADR/calibração

- Algoritmo de sequence alignment.
- Modelo de semantic clustering/dedupe.
- Otimização do portfólio além do greedy inicial.
- Thresholds por objetivo/workspace.
- Estimador de custo/duração por provider.
- UX de revisão de takes ambíguos.

