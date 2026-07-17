# ADR-084 — Classes com preflight obrigatório

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Batch, matriz final, geração de custo variável e ação destrutiva exigem token de
preflight confiável e revalidado. Apenas ação explicitamente `bounded` dispensa o
gate; classe desconhecida falha fechada.
