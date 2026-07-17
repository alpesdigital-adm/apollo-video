# ADR-087 — Superfície de governança de API clients

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

A governança externa de clients é composta por list/create, scopes limitados,
ambiente sandbox/production e lifecycle de secrets por rotação e revogação. Todas
as operações exigem `clients:admin`; bearer novo é one-shot.
