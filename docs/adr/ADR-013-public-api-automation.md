# ADR-013 — API pública, automação e MCP

> **Status:** Accepted para o chassi; autenticação de produção será refinada antes de credenciais reais
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
- Eventos saem por outbox e webhooks at-least-once assinados.
- O primeiro slice expõe somente health e capability discovery, sem dados de workspace.

## Autenticação

O domínio dependerá de `AuthenticatedExternalActor`. O primeiro mecanismo de produção será fechado antes de endpoints com dados: service-account credentials revogáveis são o baseline; OAuth 2.1 permanece previsto para delegação e integrações multiusuário.

## Consequências

- Endpoint novo não pode inventar regra paralela.
- Paridade UI/API será verificada por capability ID e contract test.
- Banco, filas, storage keys, prompts privados e payloads crus de providers não são recursos públicos.
- Health/capabilities iniciais não autorizam mutações nem revelam configuração sensível.
