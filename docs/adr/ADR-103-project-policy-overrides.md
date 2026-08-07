# ADR-103 — Override de política por projeto

## Status

Aceito em 2026-07-17.

## Decisão

Cada elemento permitido usa `inherit`, `none` ou `custom`. A resolução sempre devolve valor e origem (`workspace`, `project-none`, `project-custom`). Overrides entram no Policy Snapshot ligado à versão do projeto e também podem ser operados por endpoint dedicado.

A allowlist canônica contém logo, Instagram, YouTube, nome profissional, nome
da empresa, intro, cores, guardrails, estilo de legenda e grade preset. O
impacto editorial compara valores resolvidos, não apenas a origem: trocar
`inherit` por `none` quando ambos resolvem para ausência persiste a política,
mas não invalida artifacts. Uma mudança real de valor invalida os outputs
atuais e é diferida até o DirectorRun, que recompõe TreatmentPlan, StoryPlan,
EditPlan, proxy e final.

O endpoint de escrita usa POST com base version/hash exatos, idempotência
vinculada ao ator e transação serializável. Chaves, modos, valores e snapshots
desconhecidos ou adulterados falham fechado.

## Consequências

- desativar logo ou handle em um projeto não altera a marca global;
- o editor consegue explicar de onde veio cada valor;
- chaves não allowlisted falham antes de persistir.
- até F0.002 entregar o Brand Kit completo, apenas defaults já existentes no
  Policy Snapshot podem ser herdados; ausência não é preenchida por fallback.

## Evidência

Os commits `f0b0dd5` e `51f38a6` passaram o run remoto descartável
`f1010-20260807-r4`: 149 migrations, jornada vertical com FFmpeg e jornada
API/editor com Chromium, ambas verdes. O postflight terminou sem processos,
browsers, conexões ou containers órfãos, e a VPS foi destruída. Esta evidência
comprova integração e E2E controlado, não deploy ou aceite de produção.
