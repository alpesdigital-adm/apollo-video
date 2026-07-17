# ADR-085 — Itens de lote como operações independentes

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Cada item de lote referencia sua própria PublicOperation. Páginas retornam no
máximo 100 itens com status, `resultRef` ou erro redigido; status e retry usam as
APIs duráveis existentes por `operationId`, sem payload monolítico.
