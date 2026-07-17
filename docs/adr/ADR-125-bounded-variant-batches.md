# ADR-125 — Lotes de variantes limitados e retomáveis

## Status

Aceita em 2026-07-17.

## Decisão

Cada item e etapa de um lote possui estado, erro, artifacts, custo e retry independentes. Roteiros preservam texto e ordem originais; alinhamentos incertos são revisáveis. Takes nunca são apagados ao serem rejeitados.

O grafo de compatibilidade elimina combinações semanticamente inválidas antes do ranking. O produto cartesiano é apenas contado: jobs nascem após hard filters, threshold, dedupe, diversidade, top-N, budget e eventual confirmação. Edições em lote apresentam impacto e obedecem transação `all-or-nothing` ou `skip-failures`.

## Consequências

- Um item falho não invalida os concluídos.
- Cache hits não geram nova cobrança.
- Masters são referenciados, não duplicados.
- UI em `/batches` e API `/api/batches/v2` têm o mesmo vocabulário operacional.
