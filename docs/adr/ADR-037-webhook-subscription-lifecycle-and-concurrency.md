# ADR-037 — Lifecycle e concorrência de subscriptions de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

A API administrativa já consultava subscriptions, porém interromper uma integração ainda exigia acesso interno. Uma mutação simples de status sem controle concorrente permitiria que automações sobrescrevessem decisões recentes; exigir uma idempotency key para um estado desejado e convergente criaria ledger desnecessário. Revogação também precisa ser irreversível e distinta de uma pausa operacional.

## Decisão

- A capability `apollo.webhooks.subscriptions.status.set` expõe `PUT /v1/webhooks/subscriptions/{subscriptionId}/status` sob `webhooks:admin` e confirmação humana.
- O body contém somente `status` e `baseRevision`. Campos ausentes, extras ou estados fora de `active`, `paused` e `revoked` falham fechado.
- Toda subscription pública inclui `revision`, um SHA-256 opaco derivado de ID, status e `updatedAt`. O timestamp e a identidade interna da revisão não precisam ser expostos.
- A revisão base é obrigatória quando o estado atual difere do desejado. Divergência retorna 409 sem alterar a linha.
- Repetir o mesmo estado desejado retorna o estado atual mesmo com a revisão anterior. A operação é, portanto, naturalmente idempotente e não cria ledger.
- A máquina de estados permite `active → paused`, `paused → active`, `active|paused|pending-verification → revoked` e repetição do mesmo estado.
- `revoked` é terminal. Nenhum comando público restaura uma subscription revogada.
- Retomar uma subscription pausada exige que o endpoint relacionado continue ativo.
- A gravação usa compare-and-set por workspace, ID, status e `updatedAt`; perda da disputa retorna conflito.
- IDs fora do workspace autenticado são indistinguíveis de inexistentes e retornam 404.
- A resposta usa o mesmo presenter redigido das consultas e nunca inclui workspace, URL, secret, `keyRef`, `filterHash` ou campos de delivery/worker.

## Consequências

- UI e agentes podem interromper ou retomar fan-out sem acesso ao banco.
- Pausa preserva a possibilidade de retomada e o histórico; revogação registra uma decisão terminal.
- Clientes precisam ler a subscription antes de mudar seu estado e atualizar a revisão após cada resposta.
- Uma futura mutação de endpoint deverá coordenar atomicamente suas subscriptions para preservar o requisito de endpoint ativo durante retomada.
- Criação, challenge e rotação de signing secret continuam separadas porque exigem provisionamento protegido e efeitos externos próprios.

## Evidências exigidas

- transições válidas alteram revisão e timestamps canônicos;
- repetição do mesmo alvo é convergente e não altera a revisão;
- revisão antiga, transição terminal e retomada com endpoint inativo retornam 409;
- compare-and-set impede gravação após disputa concorrente;
- cross-workspace retorna 404 e cliente sem scope recebe 403;
- body ambíguo ou com campos extras retorna 422;
- Prisma e jornada HTTP cobrem pause, retry, conflito, resume e revoke;
- OpenAPI, schema e capability discovery descrevem a mesma operação.
