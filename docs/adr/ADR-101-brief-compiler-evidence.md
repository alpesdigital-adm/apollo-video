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
