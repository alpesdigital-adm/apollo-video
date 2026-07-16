# ADR-069 — Filtro contextual deny-only de capabilities

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Scopes isolados não representam disponibilidade por environment nem a decisão
do workspace de ocultar uma operação de um client específico. Aplicar filtros
separados em `/v1/capabilities`, `/v1/tools` e no futuro MCP criaria divergência
e poderia anunciar uma tool que o outro catálogo considera indisponível.

## Decisão

- A autenticação valida status, credential e igualdade entre environment do
  client e environment da API antes da descoberta.
- A lista visível é a interseção entre exposição externa, `availableIn`, scopes
  concedidos e ausência de deny na policy.
- A policy possui somente denies globais, por environment, workspace e client.
  Ela nunca concede capability nem amplia scope.
- `/v1/capabilities` resolve essa lista pelo mesmo serviço usado por
  `/v1/tools`; o catálogo de tools apenas transforma capabilities já filtradas.
- A configuração inicial é lida de `APOLLO_API_CAPABILITY_POLICY_JSON` e aceita
  apenas campos e capability IDs registrados. Configuração ambígua ou inválida
  falha fechada com erro estruturado e sem ecoar o conteúdo privado.
- `availableIn` ausente significa suporte em `sandbox` e `production`, mantendo
  compatibilidade com capabilities existentes.
- Administração persistente futura da policy deverá ser exposta pela Public API;
  nenhum adapter poderá alterar banco ou configuração diretamente.

## Consequências

- Scope continua sendo requisito mínimo e policy somente reduz privilégio.
- Catálogos REST e MCP não podem divergir por client ou environment.
- Workspace/client denies podem ser ativados no bootstrap sem alterar schemas
  públicos nem republicar o OpenAPI.
- O filtro controla descoberta. Endpoints REST continuam obrigados a aplicar sua
  própria autenticação e scopes; enforcement geral de policy não é inferido do
  simples desaparecimento da tool.

## Evidências exigidas

- matriz de scope, environment, workspace e client;
- capability limitada a um environment;
- rejeição de campo, selector, duplicata e capability ID inválidos;
- paridade HTTP exata entre capabilities e tools após policy;
- catálogo anônimo não afetado por deny específico de client;
- build, contratos, integrações e regressão completa verdes.
