# ADR-068 — Catálogo externo de tools para agentes

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Capabilities já declaravam endpoint, tool name, scopes e schemas de body/output,
mas um agente precisa de um único input schema que também represente path, query
e headers. Manter um catálogo separado para MCP criaria deriva em relação à API.

## Decisão

- `GET /v1/tools` deriva descriptors exclusivamente de `FOUNDATION_CAPABILITIES`
  e do registry de schemas públicos.
- Autenticação é opcional; quando presente, o mesmo filtro deny-by-default de
  scopes usado por `/v1/capabilities` determina as tools visíveis.
- O input schema possui até quatro namespaces: `path`, `query`, `headers` e
  `body`. Campos obrigatórios são derivados do endpoint e da capability.
- `Idempotency-Key` e `If-Match` tornam-se argumentos explícitos sem perder sua
  semântica HTTP.
- Output e structured error incorporam, respectivamente, o schema de saída da
  capability e `error-envelope/v2`.
- Metadata preserva capability/version, operation kind, scopes, endpoint, custo,
  confirmação e dry-run. Annotations indicam read-only e idempotência.
- Tool names seguem um padrão MCP-safe e permanecem únicos no registry.
- O adapter MCP futuro consumirá o catálogo e executará a Public API; não poderá
  acessar banco, storage ou workers diretamente.

## Consequências

- REST, agentes e MCP compartilham nomes, descrições e schemas.
- Nova capability aparece no catálogo somente após passar validação e scopes.
- O catálogo pode ser consumido por outras ferramentas sem instalar o MCP.
- Environment e policy filtering ainda precisam complementar o filtro de scopes.

## Evidências exigidas

- composição correta de path/query/headers/body;
- body opcional preservado e headers de idempotência/precondição obrigatórios;
- schemas de output e erro estruturado presentes;
- catálogo anônimo deny-by-default;
- paridade HTTP com capabilities autorizadas;
- contrato público, build e regressão completa verdes.
