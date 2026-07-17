# ADR-082 — Commit token vinculado ao preflight

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

## Decisão

O commit token v1 é HMAC e vincula client, workspace, fingerprint do input,
snapshot, fingerprint de custo e expiração. A assinatura é comparada em tempo
constante, claims inválidas falham fechadas e o token não é autorização genérica.

## Consequências

- Evidência de outro client ou workspace não pode ser reutilizada.
- Mudanças de input, versão ou custo serão detectadas na validação de commit.
- Hosts devem manter o secret fora de modelos, prompts e contratos públicos.
