# ADR-083 — Invalidação material do commit token

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

## Decisão

O commit revalida expiração e igualdade exata de client, workspace, fingerprint
do input, snapshot e fingerprint de custo. Qualquer divergência torna o token
stale; não há tolerância silenciosa nem atualização automática de custo.
