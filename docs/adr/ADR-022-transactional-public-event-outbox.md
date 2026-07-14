# ADR-022 — Outbox transacional de eventos públicos

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O envelope e o catálogo público foram fixados pelo ADR-021, mas um evento não pode ser observado se a mutação que o originou for revertida. Também não pode ser duplicado quando uma requisição idempotente apenas reproduz o resultado já persistido.

A criação de projeto é a primeira transição externa que já possui transação durável, versão inicial e replay idempotente. Ela serve como primeiro corte vertical do outbox antes de generalizá-lo para operações, artifacts e demais workflows.

## Decisão

- O application service cria `project.created` e `project.version.created` junto do aggregate, antes de chamar a porta de persistência.
- O repository recebe projeto, versão, snapshots, idempotency record e eventos no mesmo bundle.
- Projeto, versão, snapshots, resposta idempotente e linhas do outbox são gravados na mesma transação Prisma.
- Qualquer falha de unicidade ou de persistência dos eventos reverte toda a criação, incluindo o idempotency record.
- Replay idempotente retorna antes da inserção do outbox; portanto, uma repetição válida não cria novos IDs nem duplica eventos.
- O ID UUID v4 do `PublicEvent` é a chave primária global do outbox. Uma restrição adicional mantém a identidade composta disponível para isolamento por workspace.
- Cada linha preserva os campos consultáveis do envelope e armazena `data` como JSON previamente validado e normalizado pelo domínio. `publishedAt` começa nulo e significa apenas que o evento ainda não foi publicado para a próxima etapa do pipeline.
- O ator da API é persistido como `actorClientId`; delegated user, quando existir, também é preservado. Eventos de sistema podem não possuir ator externo.
- `project.created` referencia o projeto e contém nome, status, versão corrente e instante de criação.
- `project.version.created` referencia a versão, usa `sequence = 1` e contém projeto, parent nulo, base hash, snapshot refs e instante de criação.
- Constraints PostgreSQL reforçam tipo, versão, sequência, ator, recurso, objeto JSON de até 64 KiB e coerência temporal.
- Índices suportam polling pendente, inspeção workspace-scoped e busca por recurso, mas ainda não estabelecem uma promessa pública de ordem de entrega.
- A tabela é infraestrutura interna. Descoberta externa continua pelo catálogo; administração será exposta pela futura API de subscriptions/deliveries, sem publicar acesso cru ao outbox.

## Consequências

- A unicidade global dos event IDs deixa de ser apenas uma validação em memória para as transições já conectadas ao outbox.
- Somente criação de projeto e versão inicial emitem eventos nesta slice. Estar no catálogo continua não sendo evidência de emissão para os demais tipos.
- O estado pendente sobrevive a restart. O ADR-023 acrescenta os modelos de subscription e delivery attempt, mas dispatcher, claim/lease, broker e materialização de deliveries ainda não existem.
- `publishedAt` não deve ser atualizado até uma futura transação de publicação definir o destino durável e a semântica de retomada.
- At-least-once, assinatura, challenge, filtros, retry, dead-letter, replay e retenção continuam em slices posteriores.

## Evidências exigidas

- criação nova persiste exatamente os dois eventos esperados;
- replay idempotente mantém apenas os eventos originais;
- conflito de event ID reverte projeto, versão, snapshots e idempotency record;
- workspace, ator, recurso, sequence e payload persistidos correspondem ao envelope;
- eventos novos permanecem pendentes com `publishedAt` nulo;
- migrations SQLite/PostgreSQL e constraints estruturais permanecem verificáveis.
