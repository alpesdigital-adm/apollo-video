# ADR-088 — Superfície de governança de webhooks completa

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

A API de governança cobre endpoints, challenge/lifecycle, subscriptions, signing
secrets e diagnósticos/replay de deliveries, sempre autenticada e paginada. A UI
consumirá esta superfície sem criar um segundo backend administrativo.
