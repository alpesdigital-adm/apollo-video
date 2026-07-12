# ADR-001 — Estrutura modular da Apollo Video v2

> **Status:** Accepted
>
> **Data:** 12 de julho de 2026

## Contexto

A v1 combina UI, rotas, Prisma, processamento e decisões editoriais ao redor de um único `Project` e campos JSON. O produto v2 precisa de domínio versionado, workers duráveis e API pública, mas ainda se beneficia de Next.js, FFmpeg e Remotion existentes.

## Decisão

Começar como modular monolith no repositório atual:

- `src/v2/domain`: tipos, invariantes e regras puras, sem Next.js, Prisma ou providers;
- `src/v2/application`: commands, queries, ports e orchestration de casos de uso;
- `src/v2/infrastructure`: adapters de persistência, storage, queue e providers;
- `src/v2/public-api`: capability registry, contratos e presenters HTTP/MCP;
- `src/app/v1`: routes públicas que chamam application services;
- `remotion`: renderer isolado, consumindo somente `RenderInput` materializado.

Código da v1 permanece fora de `src/v2` e só entra após teste de caracterização e adapter explícito. Não haverá compatibilidade operacional com schema ou rotas antigas.

## Regras de dependência

```text
public-api ──► application ──► domain
infrastructure ──► application/domain
domain ──► nenhum framework ou adapter
renderer ◄── RenderInput materializado
```

## Consequências

- Permite slices verticais sem distribuir serviços prematuramente.
- Mantém regras testáveis sem banco ou rede.
- Workers podem ser separados depois sem mudar o domínio.
- Haverá convivência temporária entre v1 e v2 no mesmo repositório.
- Imports entre fronteiras deverão ser fiscalizados por testes/lint em etapa posterior.
