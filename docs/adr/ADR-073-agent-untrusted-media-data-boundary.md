# ADR-073 — Fronteira de dados de mídia não confiáveis

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Transcripts, OCR, captions e metadata podem conter texto que imita instruções de
sistema ou pedidos de tool. O conteúdo precisa continuar disponível ao diretor,
mas não pode herdar autoridade por estar dentro de um resultado válido.

## Decisão

- O schema é estrutura confiável; conteúdo derivado de mídia é `untrusted-data`.
- Paths reconhecidos são publicados no descriptor `agent-tool-list/v2`.
- A política desses paths é sempre `never-execute`.
- O fallback textual de tool/resource usa envelope explícito de confiança.
- `structuredContent` não é reescrito, para continuar validando contra o output
  schema, mas recebe a mesma classificação em `_meta` emitida pelo adapter.
- Nenhuma flag de confiança é aceita nos argumentos enviados pelo modelo.
- Campos desconhecidos não recebem autoridade: hosts devem tratar todo conteúdo
  de usuário/mídia como dado mesmo quando ainda não houver path específico.

## Consequências

- Prompt injection permanece visível para análise sem se tornar comando.
- Hosts podem aplicar renderização, isolamento ou filtros adicionais por path.
- Novos schemas de percepção devem usar nomes canônicos cobertos pelo walker.
- A fronteira reduz risco, mas não substitui scopes, policy ou approval.

## Evidências exigidas

- paths aninhados e em arrays são identificados deterministicamente;
- falsa instrução em transcript permanece literal e marcada como data-only;
- output schema continua sendo validado antes da resposta;
- descriptor v1 permanece imutável e v2 valida exemplos;
- regressão completa e typecheck verdes.
