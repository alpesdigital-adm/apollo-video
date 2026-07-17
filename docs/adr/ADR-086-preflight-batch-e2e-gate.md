# ADR-086 — Gate E2E de preflight e lote

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Toda regressão cobre dry-run sem mutação, token expirado, bloqueio por budget e
retry parcial que seleciona apenas operações falhas e explicitamente retryable.
