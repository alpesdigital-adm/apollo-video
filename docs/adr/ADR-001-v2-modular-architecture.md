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
- Outputs FFmpeg são materializados em arquivo parcial irmão, validados e promovidos por rename no mesmo filesystem; o path final nunca aponta para encode incompleto.
- Falha, timeout ou cancelamento preservam o derivado anterior e tentam remover o parcial; falha de cleanup/promoção possui erro tipado próprio.
- A identidade portátil de um derivado usa `media-artifact-manifest/v1`: SHA-256 do conteúdo, byte size, canonical artifact key, recipe/version, parameters hash, sources e probe opcional.
- Manifests não contêm path absoluto, timestamp volátil ou parâmetros brutos; o corpo canônico possui `manifestHash` e o writer rejeita adulteração.
- Postgres persiste `MediaArtifact`, `MediaArtifactManifest` e edges ordenados de lineage em tabelas próprias, sem blob genérico como source of truth.
- FKs compostas por workspace impedem lineage cruzado; canonical key é imutável e colisão com checksum/metadata diferente é conflito.
- Artifact, manifest e lineage são gravados na mesma transação; replay concorrente reutiliza a identidade vencedora sem duplicar rows.
- Dependências públicas devem manter `npm audit` sem vulnerabilidades antes de exposição do produto.
