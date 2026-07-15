# ADR-039 — Criação idempotente de subscriptions de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

A administração externa já consultava subscriptions e alterava seu lifecycle, mas ainda não conseguia anexar um novo filtro a um endpoint existente. Agentes externos precisam repetir uma chamada após timeout sem criar recursos duplicados, distinguir replay de conflito e receber o mesmo resultado original. A criação também precisa respeitar o estado do endpoint no mesmo instante em que persiste a subscription.

## Decisão

- A capability `apollo.webhooks.subscriptions.create` expõe `POST /v1/webhooks/subscriptions` sob `webhooks:admin` e confirmação humana.
- O body fechado aceita `endpointId`, `eventTypes` e `resourceIds` opcional; tipos de evento devem pertencer ao catálogo público e ambos os filtros são ordenados e hasheados canonicamente.
- `Idempotency-Key` é obrigatório, possui de 1 a 128 caracteres ASCII imprimíveis e é isolado por workspace e API client.
- O fingerprint vincula a chave ao endpoint e ao hash do filtro canônico. A mesma chave e payload devolve a subscription original com HTTP 200 e `replayed: true`; payload diferente devolve 409.
- A primeira criação devolve HTTP 201 e `replayed: false`. O ledger e a subscription são persistidos atomicamente em transação serializável.
- Uma subscription criada em endpoint ativo nasce ativa; em endpoint pendente de verificação nasce pendente. Endpoint suspenso ou revogado rejeita a criação com 409.
- O par endpoint + filtro exato é único. Outra chave tentando reproduzir o mesmo filtro recebe `WEBHOOK_SUBSCRIPTION_ALREADY_EXISTS`, sem adotar silenciosamente um recurso anterior.
- Endpoint, API client e workspace são verificados dentro da transação. Replays reidratam o recurso por workspace e falham de forma fechada se o resultado persistido não existir.
- A resposta pública usa o presenter redigido: não expõe workspace, URL, `filterHash`, secret, ledger ou detalhes da transação.

## Consequências

- Agentes podem repetir chamadas ambíguas de rede com segurança e obter identidade estável.
- A unicidade natural do filtro não substitui o ledger: ela bloqueia duplicatas, enquanto a chave preserva a semântica do request e sua resposta.
- Criações concorrentes convergem pelo ledger ou falham explicitamente por filtro duplicado/serialização, sem estado parcial.
- Alteração de filtro continua sendo uma operação futura separada; não há atualização implícita durante a criação.

## Evidências exigidas

- criação em endpoint ativo e pendente escolhe o estado correto;
- replay retorna o mesmo ID e não cria uma segunda linha;
- mesma chave com payload diferente e filtro duplicado com outra chave retornam conflitos distintos;
- endpoint ausente/inativo, body inválido, chave ausente e falta de scope falham antes de efeitos indevidos;
- OpenAPI declara body, header idempotente e respostas 200/201;
- contratos unitários, Prisma e jornada HTTP exercitam a implementação real.
