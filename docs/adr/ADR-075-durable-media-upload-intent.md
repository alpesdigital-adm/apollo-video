# ADR-075 — Intent durável de upload de mídia

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Antes de emitir qualquer autorização de storage, a API precisa conhecer e
validar o objeto esperado. URL assinada sem intent durável impediria quota,
checksum, idempotência, retomada e auditoria confiáveis.

## Decisão

- `begin-upload` persiste um intent sem emitir localização de storage.
- O contrato usa size decimal string para preservar inteiros grandes em JSON.
- Limite inicial é 5 TB e TTL inicial do intent é 15 minutos, ambos centralizados.
- Kind e MIME precisam pertencer à mesma família video/audio/image.
- SHA-256 lowercase é obrigatório antes de criar a sessão.
- Idempotência é única por workspace/client/key e vinculada ao fingerprint do
  intent; replay divergente falha com `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- A identidade pública é o UUID da sessão, nunca um path de bucket.
- A capability exige `media:write`; começar intent é efeito bounded sem provider.

## Consequências

- Signed sessions posteriores ficam vinculadas a um registro já autorizado.
- Upload expirado pode ser limpo sem inferir metadados do storage.
- Size, MIME e checksum podem ser revalidados no completion.
- A nova tabela é workspace/client-scoped e não contém credenciais.

## Evidências exigidas

- kind/MIME inválido, size zero/excessivo e checksum malformado falham;
- replay idêntico converge e intent diferente conflita;
- schema e migration possuem constraints equivalentes;
- resposta pública não contém path, bucket ou signed URL;
- contratos, typecheck e regressão geral verdes.
