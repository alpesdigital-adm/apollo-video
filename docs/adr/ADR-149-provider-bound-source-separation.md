# ADR-149 — Source separation provider-bound

## Estado

Implementado localmente em 2026-09-03. Integração em `main`, E2E PostgreSQL no
CI, deploy e aceite do proprietário permanecem pendentes.

## Contexto

F2.017 rejeitava música mixada porque trim, crop e cover não conseguem separar
fala de trilha. F3.017 já possuía inpaint revisado, mas ainda precisava oferecer
separação real e compará-la com as estratégias não generativas. O provider cobra
pela operação e não oferece idempotência declarada, portanto retry ingênuo pode
duplicar custo.

## Decisão

`separation` pertence ao agregado `SourceCleanupPlan`. O domínio só cria esse
candidato para um finding de música que tenha fala e stem separável. Uma oferta
gerada no servidor sela adapter, versão, provider, modelo, configuration hash,
capability hash, limites, previsões de qualidade/integridade e custo faturável.
Ela entra no fingerprint e no hash do plano; clientes não enviam provider nem
parâmetros de cobrança.

O adapter inicial é ElevenLabs Voice Isolator. Ele valida URL, source SHA-256,
duração, tamanho e oferta antes da rede. A credencial nunca integra objetos de
domínio, hashes, logs ou persistência. Antes da submissão, o adapter cria uma
intenção ligada ao operation id, source e oferta. Transporte ambíguo, intenção
órfã, arquivo parcial ou cache incompleto falham fechado e não são reenviados
automaticamente. Um resultado completo precisa ter bytes e evidência canônica
coerentes para replay sem nova chamada.

O processor remuxa o stem isolado com o vídeo original e produz exclusivamente
um derivative. `postCleanupReview` exige duração alinhada, stem presente e
binding exato do provider, além de visual e rights. A recipe de separation é
`2.0.0`; estratégias visuais mantêm `1.0.0`, preservando manifests históricos.

## Consequências

- música não separável, source sem fala, provider ausente, duração fora dos
  limites, orçamento excedido ou qualidade insuficiente continuam em fallback
  ou reject sem custo;
- a comparação crop/cover/separation/reject fica observável no plano e na UI;
- um resultado pago ambíguo exige reconciliação operacional, nunca retry cego;
- o limite vivo mínimo observado foi 4,6 s e está fail-closed no adapter;
- inpaint continua no control plane de transformação e não é duplicado aqui;
- os dois itens restantes de F3.017 só podem fechar após CI, merge, deploy e
  aceite, mesmo com testes e provider vivo aprovados localmente.

## Evidência

- domínio e policy: `tests/v2/source-cleanup.test.mjs`;
- adapter e anti-duplicação: `tests/v2/elevenlabs-voice-isolation-provider.test.mjs`;
- MP4/stem real: `tests/v2/ffmpeg-source-cleanup.integration.mjs`;
- jornada API/PostgreSQL/worker preparada:
  `tests/v2/prisma-contamination-report.integration.mjs`;
- contrato oficial consultado em 2026-09-03:
  [Audio Isolation API](https://elevenlabs.io/docs/api-reference/audio-isolation/convert/)
  e [Voice Isolator](https://elevenlabs.io/docs/overview/capabilities/voice-isolator).
