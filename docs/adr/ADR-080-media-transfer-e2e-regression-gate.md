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
- emissão, autorização e revogação de download grant.

O teste usa adapters em memória e signers reais, sem rede ou custo externo, para
ser executado em toda regressão.

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
- regressão geral e CI hospedado permanecem verdes.
