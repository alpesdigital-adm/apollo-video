# ADR-086 — Gate E2E de preflight e lote

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Toda regressão cobre dry-run sem mutação, token expirado, bloqueio por budget e
retry parcial que seleciona apenas operações falhas e explicitamente retryable.

A prova local mínima atravessa os application services reais, não factories
isoladas. A prova PostgreSQL/HTTP percorre item page, leitura da PublicOperation,
retry pela API genérica e leitura do manifest de partial retry persistido; quando
o banco isolado não estiver disponível, permanece skip-gated e não conta como
E2E executado.
