# ADR-090 — Consulta redigida de usage e audit

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

Usage e audit derivam de PublicOperations duráveis e usam a mesma paginação
estável. A resposta inclui ação, client, status, target e unidade de uso; payload,
erro bruto, lease, provider, token, secret e localização interna são omitidos.
