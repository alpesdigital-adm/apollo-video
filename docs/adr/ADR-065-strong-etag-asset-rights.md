# ADR-065 — ETag forte para direitos de assets

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

A declaração de direitos já convergia para requests idênticos, mas dois drafts
divergentes podiam ser aplicados em sequência sem provar qual estado o cliente
havia lido. Usar apenas o hash do snapshot atual como revisão permitiria ABA ao
voltar para um snapshot histórico com o mesmo conteúdo.

O contrato JSON de direitos não precisa carregar metadados de concorrência. A
API já prevê ETag/`If-Match` para resources que não pertencem a ProjectVersion.

## Decisão

- A revisão pública é um hash canônico de `artifactId` e do contador monotônico
  `rightsRevision`; o conteúdo do snapshot não funciona como version counter.
- O GET devolve essa revisão como ETag forte, inclusive no estado sem direitos.
- O PUT exige o ETag mais recente em `If-Match` e executa compare-and-set sobre o
  contador dentro da transação serializável.
- Falta de `If-Match` retorna 428, valor malformado retorna 422 e revisão obsoleta
  retorna 412.
- Repetição do mesmo draft que já é current continua sendo replay, mesmo com o
  ETag anterior, para recuperar respostas perdidas sem criar outra revisão.
- Reutilizar um snapshot histórico como novo current é uma mutação e incrementa
  a revisão, impedindo ABA.
- O OpenAPI declara precondição e ETag. A capability de escrita muda para
  `2.0.0`, e o baseline versionado é atualizado pelo comando dedicado.

## Consequências

- Drafts divergentes sobre a mesma base têm exatamente um vencedor.
- Clients e agentes precisam ler o resource antes de alterá-lo.
- O body v1 permanece estável; a precondição vive no protocolo HTTP.
- Auto-rebase não é aplicado implicitamente: conflito permanece explícito.

## Evidências exigidas

- teste de contrato do OpenAPI para `If-Match`, ETag, 412 e 428;
- jornada HTTP com estado vazio, replay idêntico e drafts divergentes simultâneos;
- incremento único de `rightsRevision` e ETag diferente após a mutação;
- regressão completa e confirmação PostgreSQL na CI de publicação.
