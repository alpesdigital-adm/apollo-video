# ADR-076 — Sessões curtas assinadas para upload de mídia

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

O intent durável precisa virar autorização de transferência sem entregar
credencial permanente, bucket ou object key ao cliente.

## Decisão

- Uploads até 100 MiB usam single session; maiores usam parts de 64 MiB.
- O número máximo é 10 mil parts.
- Token HMAC vincula versão, workspace, client, upload, modo, maxParts e expiry.
- TTL default é 10 minutos e nunca ultrapassa 15 minutos nem o intent original.
- Required headers repetem MIME e SHA-256 declarados no begin-upload.
- Multipart retorna template com `partNumber`, validado posteriormente pelo
  receiver, em vez de materializar milhares de URLs.
- A URL pública pertence ao adapter de upload; identidade interna de storage não
  faz parte do contrato.
- Banco guarda somente metadata da sessão, nunca token nem secret.

## Consequências

- Resume pode renovar autorização sem recriar o intent.
- Completion consegue verificar parts e checksum contra valores imutáveis.
- Rotação do signing secret invalida sessões ainda não consumidas.
- O receiver precisa validar assinatura, expiry, headers e partNumber.

## Evidências exigidas

- limites single/multipart e arredondamento de parts são testados;
- secret não aparece em resposta ou persistência;
- HTTP remoto é rejeitado;
- sessão expirada ou upload de outro client falha;
- regressão e contratos públicos verdes.
