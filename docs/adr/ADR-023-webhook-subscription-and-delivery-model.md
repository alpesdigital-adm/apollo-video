# ADR-023 — Modelo de subscription e delivery de webhook

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O outbox do ADR-022 preserva eventos, mas ainda não existe uma representação segura do destino, do filtro, da chave de assinatura ou das tentativas de entrega. Esses conceitos precisam ser separados antes de qualquer chamada de rede para que challenge, assinatura, retry e observabilidade evoluam sem misturar configuração com execução.

## Decisão

- `WebhookEndpoint` representa somente o destino e seu ciclo de verificação: `pending-verification`, `active`, `suspended` ou `revoked`.
- Endpoint novo sempre começa pendente. A URL é normalizada, exige HTTPS e porta 443, e rejeita credentials, query, fragment, localhost, sufixos locais e IP literal.
- A validação sintática não substitui resolução DNS segura. Challenge e cada conexão futura devem resolver novamente o hostname e bloquear endereços privados, loopback, link-local e DNS rebinding.
- `WebhookSigningSecret` é versionado por endpoint e fixa `hmac-sha256`. O banco guarda somente referência opaca a um secret provider e fingerprint SHA-256; material secreto não entra no modelo, logs ou responses.
- PostgreSQL permite somente um secret `active` por endpoint por índice parcial. O protótipo SQLite dependerá da mesma invariável no repository de rotação quando essa transição for implementada.
- `WebhookSubscription` liga endpoint e filtro. Endpoint e subscription permanecem pendentes até challenge posterior ativá-los.
- O filtro aceita de 1 a 100 event types exatos já presentes no catálogo e, opcionalmente, de 1 a 100 resource IDs. Valores são normalizados, ordenados, deduplicados e identificados por hash estável.
- Wildcards não são aceitos nesta versão para impedir ampliação silenciosa quando o catálogo ganhar tipos novos.
- Endpoint, secret inicial e subscription são criados atomicamente para workspace e API client ativos. Duplicidade de URL, referência ou filtro reverte todo o registro.
- `WebhookDelivery` representa a entrega deduplicável de um event para uma subscription e é única por `(subscriptionId, eventId)`.
- `WebhookDeliveryAttempt` representa cada tentativa numerada. Status e campos de resultado são separados da delivery agregada para permitir retry e diagnóstico sem sobrescrever histórico.
- IDs de endpoint, secret, subscription, delivery e attempt são UUID v4; relações compostas com workspace impedem associação cross-workspace.
- Constraints PostgreSQL protegem enums, estados terminais, contadores, JSON de filtro, hashes, respostas HTTP e relações temporais básicas.
- As tabelas continuam internas. A futura API administrativa exporá presenters seguros, nunca key refs, fingerprints completos, tabelas ou detalhes de rede crus.

## Consequências

- O modelo necessário para challenge, assinatura, fan-out e retry existe sem iniciar efeitos externos.
- Nenhuma delivery é materializada a partir do outbox nesta slice; `publishedAt` continua nulo.
- O challenge durável, o HMAC sobre bytes exatos e o recibo anti-replay foram definidos pelo ADR-024. Ainda não há secret provider adapter, rotação, DNS pinning, dispatcher ou chamada HTTPS.
- A API administrativa, paginação, pause/revoke, status e diagnostics continuam em slices posteriores.
- Filtros incompatíveis futuros exigirão uma versão explícita do contrato, não interpretação retroativa.

## Evidências exigidas

- URL insegura e filtro desconhecido, vazio ou duplicado são rejeitados;
- secret material direto não é aceito como referência;
- endpoint, secret e subscription compartilham workspace, endpoint e ator consistentes;
- registro duplicado ou ator ausente não deixa linhas parciais;
- delivery e attempt possuem IDs, limites e estados iniciais válidos;
- migrations contêm relações, índices de deduplicação e constraints de estado.
