# ADR-095 — Busca de projetos com filtros e cursor estável

## Status

Aceito em 2026-07-17.

## Decisão

A busca de projetos é uma consulta autenticada e isolada pelo `workspaceId`. Ela aceita texto, status, objetivo, formato, locale, intervalo de criação e owner. A ordenação canônica é `createdAt DESC, id DESC`.

O cursor contém somente posição e hash da consulta. O hash inclui workspace e filtros normalizados; portanto, um cursor não pode ser reutilizado em outro workspace nem depois de mudar qualquer filtro. As facetas estratégicas foram adicionadas como colunas opcionais e indexadas, permitindo adoção incremental sem fabricar metadados para projetos antigos.

Na interface, o estado dos filtros é preservado durante a sessão e refletido na URL. Resultados vazios possuem estado próprio e não são confundidos com um workspace sem projetos.

## Consequências

- paginação permanece determinística mesmo com timestamps iguais;
- filtros podem ser operados pela interface, API pública e MCP;
- contratos anteriores continuam disponíveis e a resposta filtrável recebe schema versionado;
- objetivo, formato, locale e owner ausentes não recebem valores presumidos.
