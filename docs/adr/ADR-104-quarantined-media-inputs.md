# ADR-104 — Entradas de mídia promovidas após probe

## Status

Aceito em 2026-07-17.

## Decisão

Vídeo, áudio e imagem são identificados pela assinatura binária; MIME e extensão devem concordar com o tipo detectado. Upload direto grava primeiro em quarentena. FFprobe valida codec, duração e dimensões e somente uma decisão `usable` promove o arquivo para a biblioteca.

Arquivos grandes usam as sessões multipart retomáveis da API pública. A interface direta expõe progresso, cancelamento e retomada dos arquivos interrompidos.

## Consequências

- extensão renomeada não contorna validação;
- mídia corrompida ou incompatível nunca entra como asset elegível;
- erros retornam ação concreta e falhas de rede preservam progresso conhecido.
