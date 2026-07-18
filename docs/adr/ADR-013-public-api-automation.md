# ADR-013 — API pública, automação e MCP

## Compatibilidade, gateway e transporte

Rotas têm major version. Campos/capabilities aditivos permanecem em v1; remoção exige nova versão, deprecation e sunset publicados e ao menos 180 dias de migração. Schemas/eventos continuam descobríveis durante a retenção pós-sunset.

Webhooks são at-least-once, assinados sobre bytes exatos e ordenados por resource quando necessário; event ID deduplica e replay é limitado/auditado. Ações caras, amplas ou destrutivas exigem preflight token curto ligado ao request. O MCP stdio oficial usa os mesmos schemas e chama a Public API autenticada.

O gateway aplica quotas por workspace/client, rate limit por capability, limites de payload e correlation IDs sem revelar tenants, filas internas, credenciais, prompts ou payloads crus de providers.

> **Status:** Accepted; autenticação de service account fechada no ADR-010
>
> **Data:** 12 de julho de 2026

## Contexto

Toda capacidade operável deve ser acessível por ferramentas e agentes externos, mantendo as mesmas políticas da UI.

## Decisão

- Contrato público REST/JSON versionado sob `/v1`.
- `PublicCapability` é o catálogo canônico de ações externas.
- OpenAPI/JSON Schema e tools MCP serão derivados do mesmo catálogo/contratos.
- MCP será adapter sobre a Public API, nunca acesso direto ao banco/workers.
- Operações longas retornam `PublicOperation`.
- Mutações exigem idempotência e precondition de versão quando aplicável.
- Ações caras, amplas ou destrutivas exigem preflight/commit token.
- Capabilities externas acionam boundaries internos sem publicá-los como recursos crus. A operação pública de render retornará um `PublicOperation`; materialização, stage, segunda revalidação, commit/discard e paths ou URLs temporárias permanecem exclusivos do worker. Não existe endpoint para obter path local, signed URL interna ou `RenderInput` descriptografado.
- Eventos sairão por outbox e webhooks at-least-once assinados. O ADR-021 fixa primeiro o envelope e o catálogo público sem afirmar que a entrega já existe.
- O primeiro slice expõe somente health e capability discovery, sem dados de workspace.

## Autenticação

O domínio depende de `AuthenticatedExternalActor`. O ADR-010 escolhe credenciais opacas e revogáveis de service account como primeiro mecanismo de produção, com múltiplas credenciais por client e rotação expand-contract. OAuth 2.1 permanece previsto para delegação e integrações multiusuário.

Autenticação humana também obedece à regra API-first. `POST`, `GET` e `DELETE /v1/session` formam o contrato versionado de login, inspeção e logout usado pela Web App e por clientes HTTP que preservem cookies. O cookie é HTTP-only e nunca aparece no body. Essas capabilities não são tools de agente; automações continuam usando Bearer de `ApiClient`, sem receber senha ou sessão humana. O bootstrap humano baseado em configuração local é provisório e não substitui a futura identidade OIDC, `WorkspaceMember`, recuperação de conta nem revogação persistente de sessões.

## Consequências

- Endpoint novo não pode inventar regra paralela.
- Paridade UI/API será verificada por capability ID e contract test.
- Banco, filas, storage keys, prompts privados e payloads crus de providers não são recursos públicos.
- Health/capabilities iniciais não autorizam mutações nem revelam configuração sensível.

## Estado implementado na Fundação

- `PublicCapability` contém metadata de autenticação, status de sucesso, idempotência, parâmetros e media type.
- JSON Schemas Draft 2020-12 formam um registry versionado; todo input/output ref de capability deve resolver nele.
- OpenAPI 3.1 é derivado do registry e publicado em `GET /v1/openapi.json`.
- Schemas individuais são publicados em `GET /v1/schemas/{schemaId}/{version}`.
- `api:v1:validate` compara capabilities, schemas e operações; o `prebuild` falha diante de refs ou operações ausentes.
- Examples publicados são validados por Ajv Draft 2020-12, incluindo `date-time`.
- Um baseline versionado impede remover capabilities ou alterar schemas existentes sob o mesmo ref sem revisão explícita.
- Novas capabilities e novos schema refs são aditivos; atualizar o baseline exige comando separado e diff revisável.
- O primeiro `PublicOperation` durável é `artifact-render`: enqueue idempotente responde `202`, leitura é workspace-scoped e o presenter omite client/workspace internos, authorization ID, RenderInput hash e storage details.
- A persistência geral da operação e o contexto específico de render usam tabelas distintas. O ADR-014 implementa claim/lease, o ADR-016 agenda retries, o ADR-017 expõe cancelamento, o ADR-018 retry manual, o ADR-019 listagem workspace-scoped e o ADR-020 descoberta de dead-letter; métricas e administração agregada permanecem posteriores.
- O ADR-021 implementa o tipo canônico `PublicEvent`, o schema e o catálogo inicial descobrível. Outbox, subscriptions, entrega assinada e replay permanecem posteriores.
