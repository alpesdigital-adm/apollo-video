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

## Runtime baseline da Fundação

- Next.js 16.2.10 e React/React DOM 19.2.7.
- Remotion, CLI, Player e Renderer 4.0.489; o subprojeto usa React/React DOM 19.2.7.
- Node.js 20.9+; desenvolvimento atual validado também em Node 24.
- Dynamic route `params` é assíncrono em pages e route handlers.
- Builds usam Webpack explicitamente enquanto os aliases de Remotion não forem migrados para Turbopack.
- O adapter FFmpeg invoca `ffmpeg`/`ffprobe` com `execFile` e arrays de argumentos, sem shell ou wrapper abandonado.
- `FFMPEG_PATH`/`FFPROBE_PATH` têm precedência; os binários empacotados são fallback e o `PATH` do worker é a última opção.
- Todo processo de mídia usa timeout finito, `AbortSignal`, `maxBuffer`, `shell: false`, `-nostdin` e saída sem progresso interativo.
- Falhas de processo são classificadas como cancelamento, timeout, limite de saída ou erro operacional; argumentos e paths não entram na mensagem pública.
- Dependências públicas devem manter `npm audit` sem vulnerabilidades antes de exposição do produto.
