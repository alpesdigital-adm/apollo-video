# ADR-082 — Commit token vinculado ao preflight

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

## Decisão

O commit token v1 é HMAC e vincula client, workspace, fingerprint do input,
snapshot, fingerprint de custo e expiração. A assinatura é comparada em tempo
constante, claims inválidas falham fechadas e o token não é autorização genérica.
Quando a criação publica `PreflightResult`, seu `fingerprint` é exatamente o
claim assinado, permitindo auditoria sem expor client, workspace, snapshot ou
fingerprint de custo.

O wire format permanece v1. Novas emissões serializam as sete claims em JSON
canônico antes do HMAC. A leitura limita tamanho antes do decode, exige base64url
canônico, assinatura com comprimento exato, objeto com chaves exatas e claims
bounded. Tokens v1 válidos emitidos com a ordem JSON anterior continuam aceitos.

## Consequências

- Evidência de outro client ou workspace não pode ser reutilizada.
- Mudanças de input, versão ou custo serão detectadas na validação de commit.
- Hosts devem manter o secret fora de modelos, prompts e contratos públicos.
