# ADR-079 — Identidade pública sem localização de storage

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

O artifact catalog usava `artifactKey` internamente para localizar objetos. Expor
essa chave como identidade pública acopla clientes ao layout e pode revelar
workspace, diretório, bucket ou estratégia do storage.

## Decisão

- A identidade pública canônica é o artifact ID.
- Campos legados `artifactKey` são apresentados como referência lógica
  `artifact:<id>`, nunca como chave interna.
- Presenters e lineage diagnostics fazem a conversão na fronteira pública.
- Um gate recursivo rejeita nomes explícitos de localização permanente.
- Referências lógicas não aceitam slash ou backslash.
- URLs de upload/download são admitidas somente como autorizações efêmeras com
  expiry, nunca como identidade persistida.

## Consequências

- O layout físico pode evoluir sem alterar contratos externos.
- Clientes usam artifact IDs e grants para acesso a bytes.
- Chaves internas permanecem disponíveis para workers e resolvers autorizados.
- Novos schemas e exemplos com localização permanente quebram a regressão.

## Evidências exigidas

- presenter não serializa o valor interno;
- lineage não vaza chave interna;
- todos os exemplos públicos passam pelo gate;
- nomes e valores semelhantes a path são rejeitados;
- contratos, typecheck e regressão permanecem verdes.
