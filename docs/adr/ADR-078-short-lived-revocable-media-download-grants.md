# ADR-078 — Download grants curtos e revogáveis

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Clientes externos precisam baixar artifacts autorizados sem receber bucket,
object key, path permanente ou credencial reutilizável do storage.

## Decisão

- Um grant pertence a exatamente um workspace, client e artifact disponível.
- Emissão exige idempotency key e TTL entre 30 e 900 segundos.
- O token HMAC vincula grant, workspace, client, artifact e expiração.
- A persistência guarda SHA-256 do token e metadados, nunca o bearer ou a URL.
- Assinatura determinística permite reconstruir resposta em replay idempotente.
- Revogação é durável, convergente e consultada antes de autorizar download.
- A URL usa grant UUID opaco; a localização de storage permanece interna.

## Consequências

- Perda de resposta pode ser recuperada sem criar grants ilimitados.
- Vazamento de banco não entrega tokens de download utilizáveis.
- O gateway de bytes precisa validar assinatura, hash, expiração e revogação.
- Rotação do secret pode invalidar tokens ainda ativos e deve ser coordenada.

## Evidências exigidas

- TTL, vínculo ao artifact e replay são testados;
- token puro não aparece na persistência;
- artifact indisponível não recebe grant;
- revogação impede autorização imediatamente;
- contratos, migration, typecheck e regressão permanecem verdes.
