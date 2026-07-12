# Spec 01 — Agente Diretor e Sistema de Qualidade

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **PRD relacionado:** FR-010–014, FR-050–066, FR-110–116, FR-130–136, FR-214  
> **Decisões dependentes:** EditPlan v2, Media Library, Provider Registry, Workspace Guardrails

---

## 1. Objetivo

Esta spec define o comportamento do Agente Diretor: como ele transforma briefing, mídia, objetivo, políticas e preferências em um plano editorial; como avalia alternativas; como solicita ou reutiliza assets; como critica o proxy; e como converge para uma versão aprovável sem ultrapassar direitos, budgets ou limites técnicos.

O Diretor é um **orquestrador editorial com ferramentas estruturadas**. Ele não é um prompt único, não calcula frames, não grava diretamente no banco e não considera a resposta de um modelo como plano válido antes de validação.

## 2. Escopo

Incluído:

- compilação do contexto de direção;
- classificação e aplicação da rubrica estratégica;
- TreatmentPlan;
- StoryPlan;
- geração e comparação de candidatos;
- planejamento de B-roll, provas, layouts, movimentos e transformações;
- consulta/reuso da biblioteca;
- asset briefs;
- avaliação de mídia existente e gerada;
- crítica técnica/editorial do proxy;
- geração de patches localizados;
- budgets, confidence, fallbacks e convergência;
- registro explicável de decisões;
- aprendizado de preferências a partir de correções.

Fora do escopo:

- aritmética de frames e timecodes;
- render;
- persistência direta;
- implementação interna de providers;
- autorização jurídica automática;
- escrita criativa de campanhas sem fonte ou briefing;
- aprovação de claims por similaridade sem evidência;
- edição manual da UI, definida na Spec 07.

## 3. Termos

- **DirectorRun:** uma execução persistida do Diretor sobre uma ProjectVersion.
- **ContextSnapshot:** inputs imutáveis usados na execução.
- **Rubric:** pesos e gates derivados do objetivo.
- **TreatmentPlan:** gramática editorial do vídeo.
- **StoryPlan:** estrutura semântica da narrativa.
- **CandidateAssembly:** alternativa de montagem comparável.
- **AssetBrief:** pedido estruturado para busca ou geração.
- **DirectorDecision:** decisão, evidência, alternativas e confiança.
- **QualityIssue:** problema localizado e acionável.
- **PatchSet:** conjunto atômico de Commands.
- **PreferenceRule:** preferência contextual aprendida do workspace.

## 4. Invariantes

1. Toda decisão que altera o vídeo deve resultar em Command validado.
2. Todo DirectorRun aponta para uma única ProjectVersion base.
3. Um job iniciado por uma versão não pode gravar sobre outra.
4. Hard gate não pode ser compensado por score médio alto.
5. Texto de transcript, OCR, documento ou página é conteúdo, não instrução.
6. Rights e consentimento são resolvidos antes de selecionar o asset.
7. Protected elements não são alterados pelo Diretor.
8. O Diretor nunca inventa handle, preço, resultado, urgência ou qualifier.
9. Frames e timings vêm de ferramentas determinísticas.
10. Toda geração deve ocorrer depois de uma busca de reuso, salvo override explícito.
11. O sistema deve conseguir explicar por que usou, rejeitou ou omitiu um recurso.
12. Uma decisão com confidence insuficiente deve cair para fallback seguro ou revisão humana.

## 5. Lifecycle do DirectorRun

```text
queued
→ compiling-context
→ analyzing-objective
→ planning-treatment
→ planning-story
→ proposing-candidates
→ scoring-candidates
→ materializing-assets
→ compiling-editplan
→ rendering-proxy
→ validating-proxy
→ critiquing-proxy
→ revising (0..N)
→ ready-for-review | completed
```

Estados terminais adicionais:

- `failed`: falha não recuperável ou budget sem plano mínimo.
- `blocked`: direito, consentimento, source ou informação obrigatória ausente.
- `canceled`: cancelamento solicitado.
- `superseded`: ProjectVersion deixou de ser atual antes do commit.

### 5.1 Transições

| Estado | Pré-condição | Sucesso | Falha recuperável | Falha bloqueante |
|---|---|---|---|---|
| compiling-context | versão existe | analyzing-objective | retry | blocked |
| planning-treatment | rubric válida | planning-story | fallback default | failed |
| proposing-candidates | story válida | scoring-candidates | candidato conservador | failed |
| materializing-assets | candidato escolhido | compiling-editplan | fallback de asset | blocked/failed |
| rendering-proxy | plan validado | validating-proxy | retry render | failed |
| critiquing-proxy | proxy válido | revising/ready | critic fallback | ready com warning |
| revising | patch validado | rendering-proxy | descartar patch | ready com issues |

Cada transição salva `startedAt`, `finishedAt`, attempts, custo, input hash e output refs.

## 6. ContextSnapshot

```ts
interface DirectorContextSnapshot {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  policySnapshotId: string
  brandKitSnapshotId?: string
  objective: VideoIntentBrief
  briefInterpretation?: BriefInterpretation
  perceptionTimelineId: string
  sourceAssetIds: string[]
  mediaIndexVersion: string
  outputSpecs: OutputSpec[]
  localeProfiles: LocaleProfile[]
  preferenceRuleIds: string[]
  protectedElementIds: string[]
  budget: DirectorBudget
  createdAt: string
}
```

O snapshot é imutável. Mudança de briefing, policy, objetivo ou preferência exige novo DirectorRun.

## 7. Compilação do contexto

### 7.1 Entradas obrigatórias

- ProjectVersion.
- Pelo menos uma fonte utilizável ou script/áudio capaz de gerar fonte.
- Objetivo primário.
- OutputSpec mínimo.
- Rights resolvíveis para as fontes pretendidas.
- PerceptionTimeline mínima ou job capaz de produzi-la.

### 7.2 Entradas opcionais

- Briefing livre.
- Oferta/CTA.
- Brand Kit.
- Assets mustUse/mustAvoid.
- Referências editoriais.
- Preferências aprendidas.
- Objective secundário.

### 7.3 Conflitos

| Conflito | Resolução padrão |
|---|---|
| projeto conversion + briefing “sem CTA” | registrar conflito; objetivo estruturado prevalece, salvo alteração explícita do objetivo |
| brandingMode none + prompt “coloque logo” | prompt vira proposta de override; não aplicar silenciosamente |
| mustUse sem rights | bloquear uso e reportar |
| duração menor que protected range | preservar range e exceder duração ou pedir decisão |
| “não mostrar pessoas” + asset com pessoa | eliminar candidato |
| transformação solicitada + novelty budget 0 | não executar; explicar |

## 8. Rubric estratégica

Scores usam escala 0–100. Pesos abaixo são defaults calibráveis por workspace, somando 100. `technicalRisk` e `costRisk` são penalidades, não dimensões positivas.

| Dimensão | Descoberta | Consciência | Aquecimento | Lead | Venda |
|---|---:|---:|---:|---:|---:|
| Objective fit | 15 | 15 | 15 | 15 | 15 |
| Hook strength | 25 | 15 | 10 | 15 | 12 |
| Clarity | 20 | 20 | 15 | 20 | 18 |
| Belief/mechanism progression | 8 | 25 | 12 | 12 | 15 |
| Evidence integrity | 5 | 10 | 18 | 15 | 18 |
| Authenticity/authority | 12 | 8 | 25 | 8 | 8 |
| Action/CTA fit | 3 | 2 | 5 | 15 | 14 |
| Rhythm/composition | 12 | 5 | 15 | 15 | 10 |

### 8.1 Gates comuns

- `rightsGate = pass`.
- `narrativeIntegrityGate = pass`.
- `technicalGate = pass`.
- `claimGate = pass` quando houver claim.
- `consentGate = pass` para identidade/voz/depoimento.

### 8.2 Thresholds iniciais

- Candidato elegível: score ponderado ≥ 65 e nenhum hard gate falho.
- Proxy pronto para revisão: score ≥ 72, zero blocker e zero high técnico.
- Auto-complete opcional: score ≥ 82, zero blocker/high e no máximo 3 medium não estruturais.
- Abaixo de 65: fallback ou revisão obrigatória.

Esses valores são defaults de implementação e devem ser calibrados com dataset de referência; não são promessa estatística.

## 9. TreatmentPlan

```ts
interface TreatmentPlan {
  objectiveRubricId: string
  narrativeMode: 'tutorial' | 'story' | 'authority' | 'offer' | 'testimonial' | 'montage'
  hookStrategy: 'chronological' | 'cold-open' | 'promise' | 'proof-first' | 'contrarian'
  energyCurve: EnergySegment[]
  visualGrammar: {
    presenterVisibility: number
    brollDensityTarget: number
    typographyDensityTarget: number
    noveltyBudget: NoveltyBudget
    movementPolicy: MovementPolicy
  }
  subtitlePolicy: SubtitlePolicy
  colorPolicy: ColorPolicy
  evidencePolicy: EvidencePolicy
  reorderPolicy: ReorderPolicy
  audioPolicy: AudioPolicyStub
  assumptions: string[]
  confidence: number
}
```

### 9.1 MovementPolicy

```ts
interface MovementPolicy {
  maxConcurrentMovements: number
  minFramesBetweenPunchIns: number
  allowed: Array<'punch-in' | 'zoom-in' | 'zoom-out' | 'pan' | 'tilt' | 'parallax'>
  maxScale: number
  faceProtection: boolean
  reduceDuringCTA: boolean
}
```

Default inicial: uma fonte de movimento dominante por vez; punch-ins não consecutivos sem retorno visual; CTA reduz movimento concorrente.

## 10. StoryPlan

StoryPlan registra, por bloco:

- papel;
- tese;
- source candidates;
- prerequisites;
- setup/payoff;
- belief before/after;
- claim/evidence needs;
- objection;
- action;
- reorder safety;
- protected qualifiers.

```ts
interface StoryBlock {
  id: string
  role: 'hook' | 'context' | 'problem' | 'mechanism' | 'proof' | 'objection' | 'offer' | 'cta'
  sourceSegmentIds: string[]
  requiredBefore: string[]
  mayMove: boolean
  selfContainedScore: number
  claims: ClaimRef[]
  proofNeeds: ProofNeed[]
}
```

## 11. Geração de candidatos

### 11.1 Quando gerar alternativas

Obrigatório quando:

- cold open é possível;
- mais de um hook válido existe;
- reordenação muda tese;
- asset caro será gerado;
- transformação generativa foi solicitada;
- prova tem múltiplos candidatos;
- confidence da melhor opção < 0,85.

### 11.2 Quantidade

- Decisão simples/reversível: 1 opção + fallback.
- Hook/estrutura: 2–4 candidatos.
- Asset: top 3 existentes; gerar até limite do budget.
- Provider caro: primeiro brief/preview de baixo custo quando possível.

### 11.3 CandidateAssembly

```ts
interface CandidateAssembly {
  id: string
  storyBlockOrder: string[]
  selectedSegments: SegmentSelection[]
  plannedAssets: AssetBrief[]
  estimatedDurationFrames: number
  estimatedCost: number
  score: EditorialScore
  hardGateResults: GateResult[]
  risks: string[]
}
```

## 12. Decision table de hook

| Condição | Ação preferida | Rejeitar quando |
|---|---|---|
| Frase forte posterior autocontida | cold open | depende de antecedente/qualifier |
| Promessa clara no início | cronológico | aquecimento longo sem valor |
| Prova visual muito forte | proof-first | prova sem contexto ou oferta diferente |
| Hook validado importado | preservar validation envelope | nova receita não entrega promessa |
| Vários hooks gravados | compatibility graph + top-N | diferença só técnica e take inferior |

## 13. Planejamento de B-roll e inserts

### 13.1 AssetBrief obrigatório

```ts
interface AssetBrief {
  id: string
  storyBlockId: string
  supportedTranscriptRange: { fromWordId: string; toWordId: string }
  narrativeRole: 'context' | 'proof' | 'contrast' | 'process' | 'emotion' | 'pattern-break'
  semanticTarget: string
  mustShow: string[]
  mustAvoid: string[]
  preferredSources: Array<'library' | 'validated' | 'evidence' | 'stock' | 'generate'>
  durationRangeFrames: { min: number; max: number }
  entryCue: string
  exitCondition: string
  compositionRequirements: string[]
  outputConstraints: string[]
  fallbackChain: string[]
}
```

### 13.2 Entrada

O insert entra em um dos seguintes cues, por prioridade:

1. boundary semântico;
2. pausa/respiração após setup;
3. gesto ou mudança de olhar;
4. palavra-chave;
5. cut técnico coberto por mídia.

### 13.3 Saída

O insert sai quando:

- claim/prova foi legível;
- fala muda de referente;
- objeto deixou de ser mencionado;
- presenter precisa retornar para confiança/CTA;
- duração máxima do brief foi atingida.

Não usar “até a próxima cena” como regra implícita.

## 14. Busca antes de geração

Fluxo obrigatório:

```text
hard filters (rights, pessoa, formato)
→ semantic retrieval
→ context rerank
→ visual inspection top-K
→ select ou declare gap
→ somente então gerar
```

Exceção precisa ser registrada: usuário solicitou geração nova, asset precisa de identidade inédita, ou biblioteca não possui candidato elegível.

## 15. Asset critic

### 15.1 Hard gates

- arquivo utilizável;
- rights/consent;
- sem claim falso;
- identidade dentro do limite;
- sem texto/logo proibido;
- duração/crop possíveis;
- ausência de artefato severo.

### 15.2 Score

| Dimensão | Peso default |
|---|---:|
| Semantic fit | 30 |
| Narrative role fit | 15 |
| Composition/format | 15 |
| Technical quality | 15 |
| Continuity | 10 |
| Brand fit | 5 |
| Editability | 5 |
| Reuse/cost value | 5 |

Elegível: ≥ 70 e hard gates pass. Entre 60–69: somente com review/fallback visível. < 60: rejeitar.

### 15.3 Fallback chain

Refinar query → outro asset existente → outro tipo de fonte → gerar → outro provider → tipografia/layout → omitir.

## 16. EditPlan compilation contract

O Diretor emite Commands de intenção. Serviços determinísticos:

- resolvem source ranges;
- calculam frames;
- verificam overlaps/gaps;
- criam format variants;
- geram RenderInput.

O Diretor recebe validation result e pode corrigir intenção, nunca editar JSON diretamente.

## 17. Proxy quality loop

### 17.1 Sampling

- início completo até pelo menos 15s;
- janelas antes/depois de cada cut/layout/asset/transform;
- proof e CTA completos;
- contact sheet uniforme do restante;
- áudio integral em análise de loudness/transcript alignment.

### 17.2 Hard validators

- source/range;
- frame preto/freeze;
- missing asset;
- texto fora do canvas/safe area;
- subtitle timing inválido;
- collision proibida;
- rights/policy snapshot;
- áudio ausente/clipping severo;
- render incompleto.

### 17.3 Multimodal critic

- objetivo;
- hook;
- clareza;
- narrativa;
- congruência;
- ritmo;
- composição;
- continuidade;
- autenticidade;
- CTA;
- marca;
- excesso/monotonia.

### 17.4 QualityIssue

```ts
interface QualityIssue {
  id: string
  category: string
  severity: 'blocker' | 'high' | 'medium' | 'low'
  fromFrame: number
  toFrame: number
  outputSpecId?: string
  locale?: string
  layerIds: string[]
  evidenceRefs: string[]
  description: string
  expectedBehavior: string
  proposedCommands: EditCommand[]
  confidence: number
}
```

Issue sem range só é aceito para problema global de narrativa/policy.

## 18. Patch policy

- Resolver blocker/high antes de medium/low.
- Não alterar protected.
- Preferir menor patch que resolve a causa.
- Agrupar patches independentes numa versão.
- Não regenerar asset quando reposicionamento resolve.
- Não mudar story para resolver problema puramente visual.
- Cada PatchSet possui expected score delta e invalidation preview.

## 19. Convergência

Máximo default: 2 ciclos automáticos de proxy no MVP, configurável até 3. Interromper quando:

- zero blocker/high;
- score ≥ threshold da rubrica;
- melhoria < 2 pontos entre iterações;
- mesma categoria reaparece duas vezes;
- budget atingido;
- solução exige decisão subjetiva ou novo direito.

Repetição da mesma falha gera issue `needs-human-review`, não loop infinito.

## 20. Confidence

| Faixa | Valor | Comportamento |
|---|---:|---|
| high | ≥ 0,85 | auto-aplicar reversível |
| medium | 0,65–0,84 | aplicar e destacar, ou escolher fallback conservador |
| low | 0,40–0,64 | não executar ação cara/irreversível; review |
| insufficient | < 0,40 | bloquear ou exigir input |

Confidence deve citar evidência e método. Não usar número sem provenance.

## 21. Budget e custo

```ts
interface DirectorBudget {
  maxModelCalls: number
  maxSearchQueries: number
  maxGeneratedImages: number
  maxGeneratedVideoSeconds: number
  maxSyntheticPresenterSeconds: number
  maxTransformations: number
  maxProxyIterations: number
  maxCostCents: number
  deadlineAt?: string
}
```

Antes de etapa cara, `estimateCost` precisa confirmar remaining budget. Exceder budget gera escolha: reuso/fallback, preview parcial ou blocked.

## 22. Preference learning

### 22.1 Registro

Toda correção captura:

- decisão original;
- contexto (objetivo, formato, cena, ator, tratamento);
- instrução do usuário;
- Command aplicado;
- resultado aceito/revertido;
- frequência de padrão semelhante.

### 22.2 Promoção

- Uma correção: project override.
- Repetição contextual: sugerir workspace preference.
- Ação explícita “sempre/nunca”: preference forte.
- Guardrail exige confirmação explícita e auditável.

### 22.3 Conflito

Regra mais específica vence dentro do mesmo nível. Policy/rights sempre vencem. Preferências conflitantes são reportadas no ContextSnapshot.

## 23. Falhas e fallbacks

| Falha | Comportamento |
|---|---|
| modelo retorna estrutura inválida | retry com repair uma vez; depois fallback determinístico |
| biblioteca indisponível | não gerar automaticamente sem budget; registrar degraded mode |
| provider falha | retry/fallback provider/tipo de mídia |
| proxy falha | retry render; não executar critic sobre output parcial |
| critic indisponível | hard validators + review obrigatório |
| policy muda durante run | run continua no snapshot, mas não publica se policy atual bloquear |
| ProjectVersion muda | marcar superseded; nunca aplicar patches |
| source some/expira | blocked com dependência explícita |

## 24. Observabilidade

Por DirectorRun:

- input hashes;
- modelos/versões;
- tools e latência;
- tokens/custo;
- queries e candidates;
- gates e scores;
- decisions e rejected alternatives;
- provider attempts;
- score por proxy iteration;
- issues/patches;
- preferences aplicadas;
- stop reason.

Logs não devem incluir secrets nem mídia sensível integral.

## 25. Dataset e calibração

Antes de auto-complete em produção, manter dataset versionado com:

- talking head distribuição/conversão;
- bons/maus hooks;
- B-roll congruente/incongruente;
- prova válida/inválida;
- legendas/colisões;
- ritmo monótono/excessivo;
- transformações aprovadas/rejeitadas;
- decisões humanas preferidas em pares.

Métricas:

- pairwise agreement com editor;
- precision de hard issues;
- false rejection de assets;
- patches por minuto;
- aprovação sem alteração;
- regressão por versão de modelo/prompt.

## 26. Cenários Given/When/Then

### DQ-01 — Descoberta sem CTA forte

**Given** objetivo descoberta e material educativo autocontido  
**When** o Diretor planeja o vídeo  
**Then** ausência de CTA forte não reduz score de action abaixo do threshold global nem força cena de venda.

### DQ-02 — Conversão com CTA incompatível

**Given** objetivo WhatsApp e CTA gravado para download  
**When** candidatos são avaliados  
**Then** compatibility/action gate falha e o CTA não é usado.

### DQ-03 — B-roll bonito e incongruente

**Given** asset de alta qualidade sem relação com a fala  
**When** Asset Critic avalia  
**Then** semantic score impede elegibilidade apesar da qualidade técnica.

### DQ-04 — Claim sem prova

**Given** claim numérico sem source/qualifier  
**When** StoryPlan solicita prova  
**Then** claim gate bloqueia exibição tipográfica e o Director reporta a lacuna.

### DQ-05 — Protected range

**Given** usuário protegeu a explicação do mecanismo  
**When** proxy critic sugere encurtar o corpo  
**Then** patch não altera o range e busca outra economia.

### DQ-06 — Loop sem melhora

**Given** segunda iteração melhora menos de dois pontos  
**When** ainda restam issues subjetivos médios  
**Then** Director encerra em ready-for-review e explica stop reason.

### DQ-07 — Budget insuficiente

**Given** transformação excede budget restante  
**When** Director escolhe materialização  
**Then** usa fallback existente/cutaway ou bloqueia com estimativa, sem submit caro.

### DQ-08 — Preferência pontual

**Given** usuário moveu legenda para cima em uma cena  
**When** correção é aceita  
**Then** vira project override, não regra global automática.

## 27. Critérios de aceite

1. Todos os estados e transições são persistidos e retomáveis.
2. DirectorRun nunca escreve sem Command/ProjectVersion.
3. Rubricas diferentes alteram scores e decisões de forma testável.
4. Hard gate sempre vence score agregado.
5. Todo asset gerado foi precedido por busca ou justificativa de exceção.
6. AssetBrief possui entry cue e exit condition.
7. Proxy issues possuem range/layer quando locais.
8. Patches não ultrapassam escopo nem protected elements.
9. Budget e stop reason são determinísticos.
10. Confidence possui provenance e muda comportamento.
11. Correção isolada não vira Guardrail.
12. Dataset detecta regressão de prompt/modelo antes de promoção.
13. ProjectVersion nova torna run antigo superseded.
14. Rights/policy podem bloquear publicação mesmo após geração.
15. Um vídeo pode terminar sem transformação/B-roll quando essa é a melhor decisão.

## 28. Questões para ADR/calibração

- Modelo/orquestrador inicial e fallback.
- Persistência do ContextSnapshot.
- Implementação de evaluator multimodal.
- Pesos definitivos após dataset.
- Limite de auto-complete por workspace.
- Política de promoção automática de modelos/prompts.
- Retenção de artifacts rejeitados.

