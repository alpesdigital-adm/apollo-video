# ADR-089 — Limites unificados por client e workspace

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Rate, concorrência, quota e spend são avaliados em uma decisão única vinculada a
workspace e client. Contadores usam inteiros; qualquer limite excedido bloqueia a
operação e retorna reasons explícitos e saldos não negativos.
