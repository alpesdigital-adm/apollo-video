# ADR-036 — Administração pública e redigida de endpoints e subscriptions de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Deliveries e replays já podiam ser diagnosticados pela API externa, mas um operador não conseguia descobrir quais endpoints e subscriptions produziam esse fluxo. Expor as linhas persistidas diretamente seria inseguro: a URL contém caminho operacional, o secret contém uma referência de cofre e os registros carregam workspace e hashes internos.

## Decisão

- Quatro capabilities read-only formam a primeira administração externa: listar e ler endpoints; listar e ler subscriptions.
- Todas exigem autenticação, scope `webhooks:admin` e exposição `workspace-admin`. O workspace vem exclusivamente do actor autenticado.
- `GET /v1/webhooks/endpoints` aceita somente `limit`, `after` e `status`; `GET /v1/webhooks/subscriptions` acrescenta `endpointId`. Parâmetros desconhecidos ou repetidos falham fechado.
- Listas são ordenadas por `createdAt DESC, id DESC`, limitadas a 100 itens e usam cursor opaco vinculado por SHA-256 ao workspace e ao conjunto exato de filtros.
- A URL completa do endpoint não integra o contrato público. A resposta contém somente a origem HTTPS canônica e um fingerprint SHA-256 da URL inteira, permitindo reconhecer mudança de destino sem revelar caminho.
- Metadados públicos de signing secret contêm versão, fingerprint, status e timestamps. `keyRef`, bytes, ciphertext e configuração do provider nunca atravessam a fronteira pública.
- A leitura individual do endpoint devolve no máximo 100 versões de metadados de secret, ordenadas por versão; a lista devolve somente a versão configurada mais recente.
- A subscription expõe seus filtros exatos de tipos de evento e, quando presentes, IDs de recurso. Esses filtros são parte do comportamento administrável, enquanto `filterHash` permanece interno.
- `workspaceId`, hashes de coordenação, challenge, leases, token e demais campos de worker não são serializados.
- Leitura de ID inexistente ou pertencente a outro workspace retorna o mesmo 404.
- Capability registry, JSON Schemas, exemplos e OpenAPI continuam sendo a única fronteira para UI, agentes e futuro adapter MCP.

## Consequências

- Operadores e agentes podem relacionar configuração, subscription e delivery sem acesso ao banco.
- A origem revela intencionalmente o host de destino a administradores, mas o caminho operacional continua redigido.
- O fingerprint permite comparação, não reconstrução nem autenticação do destino.
- Esta decisão não autoriza criação, alteração, challenge, pausa, revogação ou rotação; essas mutações exigirão contratos e idempotência próprios.
- A futura UI administrativa deverá consumir exatamente estas capabilities.

## Evidências exigidas

- cursor é rejeitado quando workspace ou qualquer filtro muda;
- filtros de status e endpoint retornam somente registros do workspace autenticado;
- leitura cross-workspace é indistinguível de recurso inexistente;
- respostas não contêm URL completa, caminho, `keyRef`, material secreto, `workspaceId` ou `filterHash`;
- filtros exatos de subscriptions e metadados redigidos de secret sobrevivem ao round-trip Prisma;
- OpenAPI e capability discovery expõem as quatro operações somente a clientes com `webhooks:admin`;
- cliente sem o scope recebe 403 e filtros desconhecidos recebem 422;
- integração Prisma e jornada HTTP autenticada executam os contratos reais.
