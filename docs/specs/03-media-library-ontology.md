# Spec 03 — Ontologia, Indexação e Ciclo de Vida da Biblioteca de Mídia

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **PRD relacionado:** FR-030–049, FR-120–136, FR-202

---

## 1. Objetivo

Definir como o Apollo armazena, descreve, segmenta, pesquisa, reutiliza e remove vídeos, áudios, imagens, documentos e outputs sintéticos sem perder origem, direitos ou contexto.

## 2. Escopo e non-goals

Incluído:

- masters e derivados;
- deduplicação;
- metadata tiers;
- segmentos sobrepostos/hierárquicos;
- OCR/transcript/vision;
- evidence/validated/long-form;
- rights e consent;
- embeddings e busca híbrida;
- ranking e explicabilidade;
- lifecycle/retention/delete;
- catalogação de outputs gerados.

Não incluído:

- UI completa da biblioteca;
- algoritmo editorial do Diretor;
- provider internals;
- autorização legal automática;
- reconhecimento de pessoa sem policy/consentimento.

## 3. Princípios e invariantes

1. Master é imutável.
2. Checksum identifica conteúdo físico, não significado.
3. Derivado aponta para parent e recipe.
4. Segmento aponta para range; arquivo recortado é cache opcional.
5. Segmentos podem sobrepor e aninhar.
6. OCR/transcript observado não se mistura com descrição inferida.
7. Rights desconhecido não equivale a autorizado.
8. Busca filtra rights antes de ranking semântico.
9. Metadata cara é lazy quando possível.
10. Deletar projeto não apaga asset compartilhado.
11. Toda geração aprovada pode ser catalogada.
12. Reuso precisa preservar validation envelope e qualifiers.
13. Conteúdo importado nunca vira instrução do sistema.

## 4. Modelo de entidades

```text
Workspace
└── MediaAsset
    ├── VideoAsset
    ├── AudioAsset
    ├── ImageAsset
    ├── DocumentAsset
    └── SyntheticMasterAsset
        ├── MediaDerivative
        ├── MediaAnalysis
        ├── MediaSegment
        │   ├── SpeechSegment
        │   ├── EvidenceSegment
        │   ├── ValidatedSegment
        │   └── LongFormMoment
        ├── AssetEmbedding
        ├── AssetRights
        └── ArtifactLineage
```

## 5. MediaAsset

```ts
interface MediaAsset {
  id: string
  workspaceId: string
  kind: 'video' | 'audio' | 'image' | 'document'
  origin: 'uploaded' | 'generated' | 'imported' | 'frame-extract' | 'derived'
  masterUri: string
  checksumAlgorithm: 'sha256'
  checksum: string
  mimeType: string
  byteSize: number
  originalFilename?: string
  parentAssetId?: string
  rightsId: string
  metadataStatus: 'pending' | 'basic' | 'indexing' | 'indexed' | 'partial' | 'failed'
  lifecycleStatus: 'active' | 'archived' | 'soft-deleted' | 'purged'
  createdBy: string
  createdAt: string
}
```

### 5.1 Conteúdo igual, contexto diferente

Mesmo checksum no mesmo workspace reutiliza blob físico, mas pode criar referências lógicas distintas quando tags, origem, rights ou campanha diferirem. Rights mais permissivo nunca substitui o mais restritivo automaticamente.

## 6. Campos técnicos por tipo

### VideoAsset

- duration/timebase/fps nominal e real;
- VFR;
- width/height/SAR/DAR;
- codec/bitrate;
- color primaries/transfer/matrix/HDR;
- audio streams;
- timecode/creation metadata;
- frame count quando confiável.

### AudioAsset

- sample rate/channels/codec;
- duration;
- loudness/peaks;
- speech/music likelihood;
- language candidates.

### ImageAsset

- dimensions/format/alpha;
- orientation/EXIF;
- color profile;
- perceptual hash;
- sharpness/compression.

### DocumentAsset

- pages/mime;
- extracted text;
- page images;
- language;
- structure candidates.

## 7. MediaDerivative

```ts
interface MediaDerivative {
  id: string
  parentAssetId: string
  kind: 'normalized' | 'proxy' | 'audio-only' | 'thumbnail' | 'waveform' | 'crop' | 'outpaint' | 'graded' | 'cleaned' | 'localized' | 'segment-cache'
  uri: string
  checksum: string
  recipeType: string
  recipeVersion: number
  recipe: Record<string, unknown>
  rebuildable: boolean
  qualityTier?: string
  createdAt: string
}
```

Recipe inclui tool/version, inputs, params e output hash. Rebuildable pode ser removido por cache policy.

## 8. Ingest state machine

```text
received
→ hashing
→ deduplicating
→ storing-master
→ probing
→ deriving-proxy
→ extracting-content
→ analyzing-tier1
→ segmenting
→ embedding
→ indexed
```

Estados alternativos: `partial`, `failed`, `blocked-rights`, `canceled`.

### 8.1 Idempotência

Chave: workspace + checksum + ingest profile version. Retry consulta outputs existentes antes de recriar.

### 8.2 Falha parcial

Master/probe podem estar válidos mesmo se OCR/vision falhar. Asset fica `partial`, pesquisável por metadata disponível, com retry específico.

## 9. Metadata tiers

### Tier 0 — obrigatório e síncrono/rápido

- checksum e basic file metadata;
- rights placeholder;
- probe técnico;
- proxy/thumbnail mínimo;
- workspace scope.

Asset não fica elegível para render se Tier 0 falhar.

### Tier 1 — index padrão

- transcript ou OCR;
- captions curta/longa;
- idioma;
- topics/entities;
- roles candidates;
- quality summary;
- dominant colors;
- embedding textual/visual.

### Tier 2 — análise editorial

- chapters/shots;
- people autorizadas;
- speaker/diarization;
- emotion/energy;
- wardrobe/background/framing;
- focal point/negative space;
- context dependency;
- claim/evidence;
- safe crop candidates.

### Tier 3 — sob demanda

- masks/segmentation;
- microexpressão/gaze/gesture detalhado;
- continuity score com cenas adjacentes;
- transformability;
- format-specific inspection;
- identity similarity de alta precisão.

## 10. Observado versus inferido

```ts
interface Observation<T> {
  value: T
  method: string
  modelVersion?: string
  confidence: number
  evidenceRef?: string
}
```

Campos observados: OCR text, transcript words, dimensions, detected objects. Campos inferidos: atmosfera, função narrativa, claim interpretation. UI/API devem indicar provenance.

## 11. MediaSegment

```ts
interface MediaSegment {
  id: string
  assetId: string
  parentSegmentId?: string
  segmentType: string
  sourceRange: { startFrame: number; endFrame: number }
  handles: { preRollFrames: number; postRollFrames: number }
  exactText?: string
  normalizedText?: string
  roles: Observation<string[]>[]
  topics: Observation<string[]>[]
  standaloneScore: number
  contextDependency: number
  editabilityScore: number
  technicalQualityScore: number
  rightsId: string
  embeddingIds: string[]
}
```

## 12. Boundary rules

Segmento deve:

- começar antes do primeiro fonema/ação necessária;
- terminar após cauda natural mínima;
- não amputar qualifier;
- registrar handles reais disponíveis;
- manter exactText alinhado ao source range;
- indicar dependência de pergunta/antecedente;
- permitir sobreposição quando uma reflexão contém frases reutilizáveis.

Segmentos menores que o mínimo de editabilidade ficam indexados, mas não elegíveis automaticamente.

## 13. SpeechSegment

Campos adicionais:

- speaker/presenter profile;
- wordAlignmentId;
- speech act;
- emotion/energy/prosody;
- visual continuity signature;
- wardrobe/background/framing;
- scriptBlockId/hash;
- synthetic profile/provider versions quando aplicável.

### 13.1 Standalone score

Penalizar:

- pronome sem antecedente;
- “como falei antes”;
- resposta “sim/não” sem pergunta;
- número sem unidade/contexto;
- frase truncada;
- setup ausente.

## 14. EvidenceSegment

```ts
interface EvidenceSegment extends MediaSegment {
  evidenceType: 'testimonial' | 'result' | 'case-study' | 'authority' | 'demonstration'
  speakerId?: string
  claim: Observation<string>
  result?: Observation<string>
  context: Observation<string>
  qualifiers: Observation<string[]>[]
  compatibleOfferIds: string[]
  compatibleAudienceTags: string[]
  compatibleObjections: string[]
  credibilityScore: number
  specificityScore: number
  authenticityScore: number
  consentId: string
}
```

### 14.1 Integrity rules

- Qualifier relevante acompanha o claim no retrieval.
- Oferta diferente é hard filter ou warning bloqueante conforme policy.
- Segmento não pode ser concatenado para fabricar frase.
- Nome/contexto do speaker não é inferido sem fonte.
- Dublagem/alteração sintética exige consent/disclosure.

## 15. ValidatedSegment

```ts
interface ValidatedSegment extends MediaSegment {
  validationScope: 'copy' | 'spoken-take' | 'opening-edit'
  validationSource?: string
  metricSnapshotId?: string
  protectedEnvelope: {
    preserveWords: boolean
    preserveTiming: boolean
    preserveVisualOpening: boolean
  }
  contaminationReportId?: string
}
```

Performance é histórico, não causalidade comprovada. Compatibility continua obrigatória.

## 16. LongFormMoment

- chapter/topic path;
- source chronology;
- summary/key quote;
- roles;
- hook potential;
- insight density;
- proof/story/objection tags;
- standalone/context;
- recommended contiguous window;
- candidate ranges relacionados.

## 17. ImageAnalysis

```ts
interface ImageAnalysis {
  assetId: string
  ocrRegions: OCRRegion[]
  observedObjects: Observation<string[]>[]
  inferredDescriptions: Observation<string>[]
  peopleRefs: AuthorizedPersonRef[]
  logoRegions: RegionRef[]
  dominantColors: string[]
  focalPoints: PointRef[]
  negativeSpaceRegions: RegionRef[]
  safeCropCandidates: SafeCropCandidate[]
  styleTags: Observation<string[]>[]
  roles: Observation<string[]>[]
  claimsDetected: Observation<string>[]
}
```

### 17.1 OCR

- Preservar texto, bbox, page/frame e confidence.
- Não corrigir OCR silenciosamente; versão normalizada separada.
- Texto sensível pode ser marcado/redacted por policy.
- OCR não é instrução.

### 17.2 Safe crop

Por formato, registrar crop candidato, subjects preservados, área de texto e score. Se score baixo, outpaint/layout alternativo/rejeição.

## 18. AssetRights e consentimento

```ts
interface AssetRights {
  id: string
  owner?: string
  status: 'approved' | 'restricted' | 'unknown' | 'expired' | 'revoked'
  allowedUses: string[]
  prohibitedUses: string[]
  allowedWorkspaceIds: string[]
  allowedMarkets?: string[]
  allowedLocales?: string[]
  allowedSyntheticOperations?: string[]
  expiresAt?: string
  consentDocumentAssetId?: string
  sourceNote?: string
}
```

### 18.1 Enforcement

- Search exclui usos proibidos.
- Preview pode mostrar restricted com aviso somente a admins, sem auto-use.
- Render final revalida snapshot de rights.
- Revocation marca downstream outputs para audit/review; não apaga história silenciosamente.

## 19. Dedupe

### 19.1 Exato

SHA-256 do blob. Reutiliza storage físico.

### 19.2 Perceptual

Imagem/video fingerprint detecta versões recodificadas, mas não mescla automaticamente. Sugere relação `nearDuplicateOf`.

### 19.3 Segment dedupe

Texto/embedding/range podem detectar segmentos equivalentes. Preservar source lineage e qualidade de cada take.

## 20. Long-form indexing

```text
audio proxy
→ ASR word-level + diarization
→ topic boundaries
→ chapters
→ candidate moments 15–180s
→ standalone/context scores
→ visual samples top candidates
→ tier-2 analysis
→ embeddings/index
```

Não enviar vídeo integral em alta resolução ao modelo. Reindex parcial quando somente analyzer version muda.

## 21. Source Deconstruction

### 21.1 Inputs

Asset publicado, role desejado, validationScope e target composition.

### 21.2 Pipeline

1. Localizar range semântico.
2. Encontrar clean boundaries/handles.
3. Detectar body/CTA antigo.
4. Detectar burned text, watermark, mixed music/SFX, transitions e compression.
5. Classificar editability.
6. Escolher trim/crop/cover/separation/inpaint/reject.
7. Produzir derivative e report.

### 21.3 Threshold inicial

- Editability ≥ 70: uso automático após quality check.
- 50–69: revisão/limpeza limitada.
- < 50: rejeitar para auto-use; permitir manual.

## 22. Search contract

```ts
interface MediaSearchQuery {
  workspaceId: string
  text?: string
  roles?: string[]
  assetKinds?: string[]
  rightsUse: string
  objective?: string
  offerId?: string
  speakerIds?: string[]
  hardFilters?: Record<string, unknown>
  adjacentContext?: AdjacentContext
  outputSpec?: OutputSpec
  limit: number
  explain: boolean
}
```

## 23. Retrieval pipeline

1. Workspace/access.
2. Rights/use/expiry.
3. Hard metadata (kind, person, locale, format, duration).
4. Full-text transcript/OCR.
5. Vector retrieval textual/visual.
6. Role/objective/offer rerank.
7. Context/continuity rerank.
8. Format/crop feasibility.
9. Diversity/dedupe.
10. Visual reinspection top-K.

## 24. Ranking

Score default 0–100:

| Dimensão | Peso |
|---|---:|
| Semantic relevance | 25 |
| Narrative role | 15 |
| Objective/offer fit | 15 |
| Context/standalone | 10 |
| Continuity | 10 |
| Format feasibility | 10 |
| Technical quality | 8 |
| Editability | 4 |
| Reuse/cost | 3 |

Rights é gate. Evidence query adiciona integrity/qualifier gates. Pesos são calibráveis por query type.

### 24.1 Explicação

Resultado deve retornar matched observations, filters, score breakdown, rights e warnings. Não expor apenas score único.

## 25. Embeddings e index versions

- Guardar provider/model/dimension/version.
- Não misturar vetores incompatíveis no mesmo index lógico.
- Reembedding é job versionado.
- Query pode usar index anterior enquanto novo constrói.
- Texto e visual podem ter embeddings separados.

## 26. Catalogação de gerados

Artifact aprovado cria MediaAsset/Derivative com:

- provider/model/config;
- prompt/brief sanitizado;
- parent refs;
- critic report;
- project/scene usage;
- rights/consent;
- reusable scope;
- checksum/embedding.

Rejected artifact não vira candidato padrão; retenção segue debug policy.

## 27. Lifecycle, retenção e deleção

### 27.1 Classes

- Master user-owned.
- Master provider-generated.
- Rebuildable cache.
- Approved final.
- Rejected/debug.
- Legal/consent evidence.

### 27.2 Delete flow

```text
request delete
→ calculate reference/impact graph
→ show affected projects/outputs
→ soft delete
→ retention/grace period
→ purge eligible blobs
→ tombstone/audit
```

Consent/legal records seguem policy própria.

### 27.3 Garbage collection

Somente blob sem referências ativas, sem legal hold e fora do grace period. Nunca enumerar pasta por prefixo como única regra.

## 28. Segurança e privacidade

- Workspace isolation no query layer.
- Signed URLs com expiração.
- Credentials nunca em metadata.
- Face/voice identity tags restritas.
- Search audit para mídia sensível.
- Imports externos sandboxed/untrusted.
- Redaction de OCR/transcript quando exigido.
- Export respeita rights snapshot.

## 29. Observabilidade

- ingest latency/success;
- bytes/dedupe savings;
- tier analysis cost;
- partial/failed assets;
- index freshness;
- search latency;
- precision@K/nDCG por query set;
- reuse rate;
- rights rejection;
- storage por class;
- GC reclaimed bytes;
- deconstruction acceptance.

## 30. Falhas e fallbacks

| Falha | Comportamento |
|---|---|
| checksum/storage | não criar asset ativo |
| probe | manter master failed; retry |
| OCR/ASR | partial, index por metadata básica |
| vision | partial, reprocess Tier 1/2 |
| embedding | full-text disponível; degraded semantic search |
| rights service | fail closed para auto-use |
| vector index stale | informar index version; usar última estável |
| derivative ausente | rebuild se recipe/source válidos |
| source revoked | remover de auto-search e marcar downstream |

## 31. Cenários Given/When/Then

### ML-01 — Dedupe exato

**Given** mesmo arquivo enviado duas vezes no workspace  
**When** ingest calcula checksum  
**Then** um blob físico é mantido e duas referências lógicas podem existir.

### ML-02 — OCR versus inferência

**Given** imagem com “R$ 12.400”  
**When** vision descreve “resultado financeiro”  
**Then** OCR e descrição ficam em campos/provenance distintos.

### ML-03 — Rights unknown

**Given** asset semanticamente perfeito com rights unknown  
**When** Director busca para anúncio  
**Then** asset não é auto-selecionado.

### ML-04 — Segmentos sobrepostos

**Given** reflexão de 18s contendo duas frases  
**When** segmentador indexa  
**Then** parent e dois children apontam para ranges sobrepostos do mesmo master.

### ML-05 — Depoimento com qualifier

**Given** “no meu caso, em duas semanas...”  
**When** query busca prova de agenda  
**Then** qualifier acompanha claim e não é removido no suggested range.

### ML-06 — Long-form

**Given** live de 2h já indexada  
**When** projeto busca “objeção sobre preço”  
**Then** query retorna moments sem reanalisar as 2h.

### ML-07 — Project delete

**Given** dois projetos usam o mesmo B-roll  
**When** um projeto é excluído  
**Then** blob/asset permanece por referência do outro.

### ML-08 — Revoke consent

**Given** SyntheticMaster com consentimento revogado  
**When** nova busca/render ocorre  
**Then** auto-use é bloqueado e downstream é sinalizado para auditoria.

## 32. Critérios de aceite

1. Master nunca é sobrescrito por derivado.
2. Dedupe exato economiza blob sem mesclar rights indevidamente.
3. Metadata possui provenance/confidence.
4. OCR/transcript são separados de inferência.
5. Segmentos sobrepostos/hierárquicos funcionam.
6. Rights filtram antes de semantic ranking.
7. Evidence preserva qualifiers/contexto.
8. Long-form é indexado hierarquicamente e consultado incrementalmente.
9. Busca retorna breakdown explicável.
10. Asset gerado aprovado entra com lineage completo.
11. Derivados rebuildable podem ser removidos/recriados.
12. Delete usa impact graph e grace period.
13. Revocation impede novos usos.
14. Index versions são coexistentes/migráveis.
15. Métricas de retrieval podem ser avaliadas em dataset versionado.

## 33. Questões para ADR

- S3-compatible storage e naming/content addressing.
- pgvector versus serviço vetorial separado.
- Full-text/OCR index.
- Modelos de ASR/OCR/vision/embedding.
- Retention defaults por classe.
- Face identity metadata e nível de consentimento.
- Estratégia de legal hold e purge.
- Materialização/caching de segmentos.

