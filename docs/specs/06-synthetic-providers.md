# Spec 06 — Providers Sintéticos e Transformação Generativa

> **Status:** Implementation-grade draft  
> **Versão:** 2.0  
> **PRD relacionado:** FR-092–116, FR-123, FR-193

## 1. Objetivo

Definir contratos e execução de TTS, avatar, lip-sync e transformação generativa, desacoplando o domínio de HeyGen, ElevenLabs, Higgsfield ou qualquer provider específico.

## 2. Invariantes

1. Diretor pede capability, não provider, salvo override.
2. Áudio é timeline-mestre do apresentador/lip-sync.
3. Job externo tem estado persistido no Apollo.
4. Output bruto é salvo antes da composição.
5. Consentimento e rights são gates antes do submit e do reuso.
6. Cache key inclui versões de perfil/provider/config.
7. Retry nunca duplica cobrança quando provider aceita idempotency key.
8. Artifact rejeitado não vira candidato padrão.
9. Provider output não é confiável antes do critic.
10. Falha deve cair para alternativa de menor risco/custo quando possível.

## 3. Arquitetura

```text
Director/Workflow
→ Synthetic Domain Service
→ Provider Registry
→ Routing Decision
→ Adapter
→ API ou MCP transport
→ ProviderJob
→ Artifact ingest
→ Technical validation
→ Specialized critic
→ approved/rejected
→ Media Library
```

## 4. Adapter

```ts
interface AsyncMediaProviderAdapter<I, R> {
  id: string
  adapterVersion: string
  getCapabilities(): Promise<ProviderCapabilities>
  estimate(input: I): Promise<ProviderEstimate>
  submit(input: I, ctx: SubmitContext): Promise<{ providerJobId: string }>
  getStatus(providerJobId: string): Promise<ProviderStatus>
  retrieve(providerJobId: string): Promise<R>
  cancel?(providerJobId: string): Promise<void>
  verifyWebhook?(request: unknown): Promise<ProviderWebhookEvent>
}
```

Adapter normaliza erros para códigos Apollo e nunca expõe secret ao domínio.

## 5. Capability schema

```ts
interface ProviderCapabilities {
  operations: Array<'tts' | 'audio-avatar' | 'text-avatar' | 'lip-sync' | 'image-to-video' | 'video-to-video' | 'background-replace' | 'camera-motion'>
  inputFormats: string[]
  outputFormats: string[]
  locales?: string[]
  aspectRatios?: string[]
  duration: { minSeconds: number; maxSeconds: number }
  identityReference: 'none' | 'image' | 'video' | 'profile-id'
  backgroundModes?: string[]
  supportsSeed: boolean
  supportsIdempotency: boolean
  completion: 'polling' | 'webhook' | 'both'
  concurrencyLimit?: number
  regionRestrictions?: string[]
}
```

Capabilities possuem fetchedAt/TTL. Job já submetido não muda com refresh.

## 6. Provider routing

### 6.1 Hard filters

- operação;
- duration/format/locale;
- identity/background requirements;
- market/region;
- rights/consent;
- availability;
- workspace allow/deny list.

### 6.2 Ranking

```text
quality history 35%
cost 20%
latency 15%
reliability 15%
continuity with existing assets 10%
cache/provider affinity 5%
```

Override explícito fixa provider, mas não ultrapassa rights/capability gates.

## 7. ProviderJob

```ts
interface ProviderJob {
  id: string
  workspaceId: string
  operation: string
  adapterId: string
  adapterVersion: string
  providerJobId?: string
  originProjectVersionId: string
  inputHash: string
  idempotencyKey: string
  estimate: ProviderEstimate
  attempt: number
  status: ProviderJobStatus
  submittedAt?: string
  heartbeatAt?: string
  completedAt?: string
  normalizedError?: ProviderError
}
```

Estados:

```text
planned → estimated → submitted → queued → processing
→ retrieving → ingesting → evaluating → approved | rejected
```

Terminais adicionais: failed, canceled, expired, superseded.

## 8. Polling/webhook

- Webhook verifica assinatura, event ID e replay.
- Event é idempotente.
- Polling usa backoff/jitter e deadline.
- Webhook e polling podem coexistir; primeira transição válida vence.
- Status regressivo do provider não regride estado Apollo.
- Job sem heartbeat acima do SLA vira `suspected-stalled`, não `failed` imediato.

## 9. TTS

Input:

- exact script block;
- locale;
- VoiceProfile/version;
- pronunciation dictionary;
- tone, pace, energy;
- output audio constraints.

Output bruto e normalizado incluem checksum, duration, sample rate e alignment quando disponível.

### 9.1 Gate de texto

Antes do TTS validar claims, números, pronunciation terms e script hash aprovado. Provider não pode reescrever texto silenciosamente; transcript do output é comparado ao script.

## 10. Avatar/lip-sync

- Preferir geração por StoryBlock de duração compatível.
- Manter handles de entrada/saída.
- Perfil/roupa/fundo/config devem permanecer estáveis entre blocos da mesma continuidade.
- Áudio checksum vincula vídeo.
- Mudança do áudio invalida avatar/lip-sync.

## 11. SyntheticPresenterProfile

```ts
interface SyntheticPresenterProfile {
  id: string
  version: number
  actorIdentityId: string
  avatarRefs: ProviderProfileRef[]
  voiceProfileIds: string[]
  defaultLocale: string
  pronunciationDictionaryId?: string
  visualContinuity: { wardrobe?: string; background?: string; framing?: string }
  consentId: string
  status: 'active' | 'disabled' | 'expired'
}
```

## 12. Consent gate

Validar:

- avatar e voz;
- operação (TTS, clone, lip-sync, transformation);
- objetivo comercial;
- workspace/projeto;
- locale/market;
- expiry/revocation;
- disclosure.

Revogação impede novos submits/reuse e sinaliza downstream; não apaga auditoria.

## 13. SyntheticMasterAsset

Salvar:

- provider original URI localmente ingerido;
- normalized video;
- audio separado;
- script/alignment;
- provider/adapter/model/config;
- profile versions;
- job/payload sanitizado;
- cost/latency;
- checksums;
- consent snapshot;
- critic result.

Composição, legenda, LUT e B-roll são derivados; não alteram master.

## 14. Cache

```text
hash(adapter/version + model/config + presenterVersion + voiceVersion + audioChecksum + format + direction + background)
```

Cache hit só é utilizável se:

- artifact approved;
- blob disponível;
- rights/consent atuais permitem;
- output constraints atendidos;
- nenhum mustRegenerate explícito.

## 15. TransformationBrief

```ts
interface TransformationBrief {
  sourceAssetId: string
  sourceRange: FrameRange
  intent: 'pattern-break' | 'visual-metaphor' | 'demonstration' | 'dramatic-emphasis' | 'world-shift' | 'camera-enhancement'
  mode: 'generated-cutaway' | 'background-plate' | 'actor-composite' | 'background-replace' | 'video-to-video' | 'camera-motion' | 'restyle'
  prompt: string
  negativeConstraints: string[]
  preserve: { identity: boolean; lips: boolean; expression: boolean; bodyMotion: boolean; wardrobe: boolean }
  target: Record<string, unknown>
  outputSpecIds: string[]
  durationFrames: number
  fallbackModes: string[]
}
```

## 16. Risk ladder

| Nível | Modo | Risco dominante | Uso inicial |
|---:|---|---|---|
| 1 | camera motion/parallax | crop/motion | permitido |
| 2 | generated cutaway | semântica/continuidade | permitido |
| 3 | background plate + composite | edges/light | permitido com critic |
| 4 | background replace | identity/temporal | limitado |
| 5 | full video-to-video | identity/lips/flicker | experimental/review |

Director escolhe menor nível que cumpre a intenção.

## 17. Exemplo medieval

Fala: “gestão de tráfego medieval”.

1. Tentar background plate medieval + actor composite por 2–4s.
2. Preservar rosto/lips/áudio.
3. Entrada na palavra-chave, saída após payoff.
4. Se edges/identity falham, usar cutaway medieval.
5. Se cutaway incongruente, still/parallax.
6. Se nenhum passa, omitir transformação.

## 18. Critics

### TTS

- script transcript match ≥ threshold;
- pronunciation terms;
- prosody;
- noise/clipping;
- voice identity quando autorizado.

### Avatar/lip-sync

- face identity;
- lip alignment;
- teeth/eyes/hands;
- temporal consistency;
- expression/tone;
- start/end handles;
- continuity com blocos.

### Transformação

- semantic fit;
- preserve constraints;
- flicker/warping;
- anatomy;
- composite edges/light;
- transition quality;
- format/safe areas.

Hard gate falho → rejected, não compensado por estética.

## 19. Thresholds iniciais

- Transcript match TTS: ≥98% tokens normalizados; qualquer número/nome divergente bloqueia.
- Identity score: threshold calibrado por provider/profile; abaixo do limite de consented profile bloqueia.
- Lip-sync high: erro mediano ≤2 frames; medium 3–4; acima exige review/reject.
- Flicker severo em frame crítico: reject.

Valores serão calibrados por dataset e não devem ser hardcoded fora de policy versionada.

## 20. Retry/fallback

- Retry técnico: mesmo input/idempotency, máximo policy.
- Retry criativo: novo attempt/config/hash.
- Provider fallback: novo job/lineage.
- Regerar somente block/range falho.
- Após duas falhas sem melhora, descer risk ladder.
- Budget excedido: cache/library/simple composition.

## 21. Erros normalizados

AUTH, RATE_LIMIT, QUOTA, INVALID_INPUT, UNSUPPORTED_CAPABILITY, PROVIDER_TIMEOUT, CONTENT_POLICY, CONSENT_BLOCK, JOB_FAILED, OUTPUT_MISSING, OUTPUT_CORRUPT, WEBHOOK_INVALID.

Cada código define retryable, userAction e provider fallback eligibility.

## 22. Segurança

- Secrets por secret ref.
- URLs assinadas e expiráveis.
- Webhook signature/replay protection.
- Payload log sanitizado.
- Mídia externa verificada antes de ingest.
- Audit de uso de identidade/voz.
- Provider data retention registrada quando conhecida.

## 23. Observabilidade

- estimate versus actual cost/latency;
- success/reject por provider/operation;
- cache hit;
- retry/fallback;
- critic dimensions;
- consent blocks;
- stalled jobs;
- webhook/polling events;
- reusable synthetic seconds.

## 24. Cenários Given/When/Then

### SP-01 — Cache

**Given** áudio/config/profile idênticos e consent válido  
**When** bloco é solicitado novamente  
**Then** approved master é reutilizado sem provider submit.

### SP-02 — CTA alterado

**Given** vídeo em blocos  
**When** apenas CTA muda  
**Then** TTS/avatar do CTA são regenerados; hook/body preservados.

### SP-03 — Job stale

**Given** provider conclui após versão remover o bloco  
**When** artifact é ingerido  
**Then** vai ao cache/lineage, não ao projeto atual.

### SP-04 — Consent revogado

**Given** master existente com consent revoked  
**When** novo projeto tenta reutilizar  
**Then** cache gate bloqueia.

### SP-05 — V2V falho

**Given** transformação medieval altera rosto/lips  
**When** critic rejeita  
**Then** workflow desce para composite/cutaway.

### SP-06 — MCP desconecta

**Given** job submetido por adapter MCP  
**When** sessão termina  
**Then** ProviderJob persiste e polling/webhook continua.

## 25. Critérios de aceite

1. Adapter mock substitui provider sem alterar domínio.
2. Capability mismatch bloqueia antes do submit.
3. Estimate/budget antecedem job pago.
4. Idempotency impede duplicação técnica.
5. Output bruto é ingerido antes de composição.
6. Cache valida consent/rights atuais.
7. Jobs sobrevivem restart/MCP disconnect.
8. Critics produzem scores/gates localizados.
9. Retry é por bloco/range.
10. Fallback segue risk ladder.
11. Revogação bloqueia novos usos.
12. Toda geração possui lineage/custo/config.

## 26. Questões para ADR

- Adapters iniciais e capability discovery.
- Queue/poll/webhook architecture.
- Armazenamento do payload sanitizado.
- Modelos/thresholds de critic.
- Política de artifact rejeitado.
- Disclosure de synthetic media por mercado.

