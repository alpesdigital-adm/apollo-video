# ADR-006 — Commands, versões e concorrência

> **Status:** Accepted
>
> **Data:** 12 de julho de 2026

## Contexto

Usuário, Diretor, API e agentes precisam alterar o mesmo projeto sem estados paralelos ou sobrescrita silenciosa.

## Decisão

- Toda mutação de produto é um `EditCommand` tipado.
- Command contém `baseVersionId`, `baseHash`, actor, scope, payload, idempotency key e timestamp.
- Scope vazio ou contraditório é inválido.
- Toda mudança confirmada cria `ProjectVersion` imutável.
- A versão carrega sequência linear dentro do projeto, parent e snapshot refs.
- Concorrência usa `baseVersionId` + `baseHash`; mismatch retorna conflito até existir rebase seguro explícito.
- Persistência futura gravará command, patch, nova versão e outbox na mesma transação.
- UI, API REST e MCP usam o mesmo handler.

## Primeiro slice

O primeiro slice implementa contratos, validação de scope, validação de versão e hashing determinístico. Persistência e rebase automático ficam para slices posteriores.

## Consequências

- Não existe update direto de JSON/tabela na v2.
- Undo e restore serão novos Commands/versões.
- Idempotência precisa ser resolvida antes de efeitos externos.
- Jobs recebem a versão de origem e não promovem resultado stale.
