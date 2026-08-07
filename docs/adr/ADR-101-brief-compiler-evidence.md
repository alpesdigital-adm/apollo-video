# ADR-101 — Brief Compiler orientado por evidências

## Status

Aceito em 2026-07-17.

## Decisão

O modelo não entrega texto livre ao Diretor. Ele produz `CompiledBrief/v1`, com sete campos, spans verificáveis na entrada, confidence e conflitos. Evidência cujo trecho não coincide exatamente com a fonte é rejeitada.

Somente conflitos materiais pedem revisão. Prompt, modelo e schema são versionados; entrada e saída persistíveis são redigidas e acompanhadas de hashes do conteúdo integral.

## Consequências

- extrações podem ser auditadas até o trecho do briefing;
- guardrails não podem ser anulados pelo próprio texto;
- evolução do compilador é comparável em golden sets estáveis.

## Evidência de implementação

Em 2026-08-07, os SHAs `b28c3f8`, `9d4adc2` e `be4138e` conectaram a decisão ao
Diretor síncrono e ao worker durável. O Brief Snapshot `v3` persiste compilação
e audit content-addressed, e `project-workspace/v10` reidrata o conteúdo com
validação fail-closed. O run supervisionado `f1008-20260807-r9` passou por 148
migrations, PostgreSQL, API Next e Chromium, com postflight zero e VPS
destruída. Essa evidência comprova integração/E2E controlado, não implantação
ou aceite do produto.
