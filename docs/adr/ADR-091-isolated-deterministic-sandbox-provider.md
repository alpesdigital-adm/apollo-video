# ADR-091 — Provider fake isolado de sandbox

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

O fake de sandbox é determinístico, não chama rede, gera receipt estável e custo
simulado em minor units. Uso fora de `sandbox` falha fechado.
