# ADR-031 — Diagnóstico público e redigido de webhook deliveries

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O worker já mantém estado, tentativas e resultados técnicos de deliveries, mas operadores externos não conseguem localizar falhas ou distinguir retry agendado de dead-letter sem acesso direto ao banco. Expor a linha bruta seria inseguro: ela contém campos de lease e relações que podem levar a endpoint, payload e credenciais.

## Decisão

- A administração externa começa com duas capabilities read-only: listar deliveries e ler uma delivery com seu histórico de attempts.
- Ambas exigem autenticação e o scope `webhooks:admin`; a exposição é `workspace-admin` e toda consulta recebe o workspace do actor autenticado.
- `GET /v1/webhooks/deliveries` aceita somente `limit`, `after`, `status`, `endpointId` e `eventId`. Parâmetros desconhecidos ou repetidos falham fechado.
- A lista é ordenada por `createdAt DESC, id DESC`, limitada a 100 itens e usa cursor opaco vinculado por SHA-256 ao workspace e a todos os filtros.
- Reutilizar cursor com outro workspace, status, endpoint ou evento é inválido.
- `GET /v1/webhooks/deliveries/{deliveryId}` devolve a delivery e até 20 attempts ordenados por número crescente.
- O contrato público inclui IDs, status, contadores, agenda, timestamps, status HTTP, hash da resposta e código de erro redigido.
- O contrato exclui `workspaceId`, URL, secret/key reference, payload/event data, assinatura, headers, lease owner/token/hash, heartbeat e corpo de resposta.
- Uma delivery de outro workspace é indistinguível de inexistente e retorna 404.
- As capabilities, schemas, exemplos e rotas OpenAPI são a fonte para API, agentes e futuro adapter MCP; não haverá boundary administrativo paralelo.
- Índices específicos cobrem listagem geral, filtro por evento e percurso por subscription. O filtro por endpoint usa a relação endpoint→subscriptions sem duplicar endpoint na delivery.

## Consequências

- Operadores e agentes conseguem localizar e diagnosticar falhas sem acesso interno.
- A API fornece a identidade necessária para o futuro replay controlado, mas esta decisão não autoriza replay, rotação ou alteração de subscription.
- Status HTTP e hashes ajudam correlação sem armazenar ou revelar o corpo recebido.
- A UI administrativa futura deverá consumir estas mesmas capabilities.

## Evidências exigidas

- cursor de uma combinação de filtros é rejeitado em outra;
- filtro por status, endpoint e evento retorna somente deliveries do workspace autenticado;
- leitura cross-workspace retorna 404;
- attempts permanecem ordenados e não expõem IDs internos redundantes ou lease;
- OpenAPI e capability discovery publicam as duas operações somente para `webhooks:admin`;
- cliente sem scope recebe 403;
- resposta HTTP não contém URL, payload, workspace, assinatura ou segredo;
- integração Prisma e jornada HTTP autenticada executam os contratos reais.
