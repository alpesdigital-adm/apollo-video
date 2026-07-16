# ADR-074 — Loop mínimo do diretor sobre tools autorizadas

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Era necessário provar a jornada real de um agente, não apenas o adapter MCP.
Esse runner não pode recriar catálogo, liberar tool inventada ou chamar domínio
interno diretamente.

## Decisão

- O diretor inicial usa `ToolLoopAgent` da versão instalada do AI SDK.
- Dynamic tools são geradas exclusivamente dos descriptors autenticados.
- Input schema usa `jsonSchema` oficial; execução usa o cliente da Public API.
- Tool ausente não possui executor e é registrada como invalid tool call.
- Resultado de mídia inclui a fronteira data-only antes de voltar ao modelo.
- Tool com approval/preflight não executa neste runner sem futuro canal de
  evidência confiável; ausência falha fechada.
- E2E usa `MockLanguageModelV4`, sem rede, credencial ou custo de provider.

## Consequências

- Existe uma base executável do agente diretor com superfície mínima e testável.
- MCP e runner direto compartilham descriptors e cliente HTTP.
- A seleção criativa do diretor continua futura; esta slice prova segurança e
  plumbing, não qualidade editorial.
- Integração de approval no runner deverá reutilizar o gate da F0-081.

## Evidências exigidas

- jornada válida chama uma tool autorizada exatamente uma vez;
- transcript adversarial chega ao modelo marcado como dado e não dispara tool;
- tool ausente não chama a Public API;
- nenhuma chamada real de modelo ocorre nos testes;
- typecheck e regressão geral verdes.
