# ADR-013 — API pública, automação e MCP

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
- Capabilities externas acionam boundaries internos sem publicá-los como recursos crus. Exemplo: a futura operação de render usa a autorização para materializar assets dentro do worker; não existe endpoint para obter path local, signed URL interna ou `RenderInput` descriptografado.
- Eventos saem por outbox e webhooks at-least-once assinados.
- O primeiro slice expõe somente health e capability discovery, sem dados de workspace.

## Autenticação

O domínio depende de `AuthenticatedExternalActor`. O ADR-010 escolhe credenciais opacas e revogáveis de service account como primeiro mecanismo de produção, com múltiplas credenciais por client e rotação expand-contract. OAuth 2.1 permanece previsto para delegação e integrações multiusuário.

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
