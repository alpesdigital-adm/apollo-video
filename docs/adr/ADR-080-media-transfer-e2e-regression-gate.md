# ADR-080 — Gate E2E da transferência externa de mídia

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Upload, resume, verificação, artifact e download grant possuem invariantes locais,
mas falhas de integração podem permitir corrupção, perda de progresso ou acesso
depois da revogação.

## Decisão

Uma jornada determinística obrigatória conecta o ciclo completo e cobre:

- upload multipart grande;
- interrupção e retomada pelas parts ausentes;
- expiração e renovação da sessão assinada;
- rejeição de checksum autoritativo divergente;
- conclusão verificada;
- emissão, autorização e revogação de download grant;
- stream full/range pelo driver configurado, com tamanho, checksum e versão
  imutável revalidados antes da entrega.

O teste usa adapters em memória, storage local temporário, S3 controlado e
signers reais, sem rede ou custo externo, para ser executado em toda regressão.
O adapter S3 exige `VersionId`, checksum e tamanho no HEAD, fixa a mesma versão
no GET e valida `Content-Range`; o adapter local verifica o hash antes do stream.

## Consequências

- Mudanças em qualquer fronteira da transferência são verificadas em conjunto.
- A jornada é rápida e determinística, mas não substitui integração PostgreSQL e
  storage real no CI hospedado.
- Novos adapters de storage devem reutilizar os mesmos cenários de aceitação.

## Evidências exigidas

- quatro parts são calculadas para 256 MiB;
- receipts sobrevivem à interrupção;
- sessão expirada e checksum incorreto falham;
- grant revogado não autoriza download;
- bytes adulterados, objeto sem versão ou range inconsistente não cruzam o port;
- regressão geral e CI hospedado permanecem verdes.
