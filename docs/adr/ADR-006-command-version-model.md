# ADR-006 — Commands, versões e concorrência

## Patch, transação e inversão

O envelope contém actor, versão/hash base, scope, preconditions, operações tipadas e idempotency key. O resultado registra nova versão, patch aplicado, inverso seguro, invalidação e conflito. Command, patch, versão, current pointer e outbox são atômicos.

Undo, redo e restore são novos commands auditáveis; nunca apagam histórico. Auto-rebase só ocorre com histórico completo e targets sem overlap. Fixtures exercitam replay determinístico, inversão permitida, idempotência e rollback.

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
- Concorrência usa `baseVersionId` + `baseHash`; o resolver do ADR-067 permite
  auto-rebase explícito somente sobre histórico completo e sem overlap semântico.
- Persistência futura gravará command, patch, nova versão e outbox na mesma transação.
- UI, API REST e MCP usam o mesmo handler.

## Primeiro slice

O primeiro slice implementou contratos, validação de scope, validação de versão e
hashing determinístico. O ADR-067 entregou resolução de auto-rebase/conflito;
persistência transacional de command, patch e nova versão permanece posterior.

## Consequências

- Não existe update direto de JSON/tabela na v2.
- Undo e restore serão novos Commands/versões.
- Idempotência precisa ser resolvida antes de efeitos externos.
- Jobs recebem a versão de origem e não promovem resultado stale.
