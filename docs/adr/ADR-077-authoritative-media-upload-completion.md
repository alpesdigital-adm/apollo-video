# ADR-077 — Conclusão autoritativa antes do ingest

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Uma sessão assinada comprova autorização de transferência, mas não comprova que
o objeto armazenado corresponde ao intent nem que todas as partes chegaram.

## Decisão

- Receipts multipart são persistidos por upload e número da parte.
- Repetir o mesmo número substitui o receipt e permite retomada após interrupção.
- A consulta de resume deriva a lista de partes ausentes do tamanho imutável e do
  tamanho de part registrado na sessão.
- Completion multipart exige sequência completa e então consulta um verifier de
  storage por origem fixa.
- O verifier devolve tamanho, MIME e SHA-256 observados; os três devem coincidir
  exatamente com o intent antes do estado `verified`.
- Completion já verificada é replay sem nova chamada externa.
- O contrato público não contém bucket, object key ou path interno.

## Consequências

- Upload interrompido pode continuar sem recriar intent nem repetir parts válidas.
- Receipt não é tratado como prova de integridade do objeto final.
- Ingest futuro deve aceitar somente uploads no estado `verified`.
- O adapter de storage precisa implementar verificação autoritativa e limitada.

## Evidências exigidas

- parts ausentes e substituição de receipt são testadas;
- multipart incompleto falha antes do verifier;
- divergências de tamanho, MIME ou checksum impedem conclusão;
- replay verificado não repete efeito externo;
- contratos, migration, typecheck e regressão permanecem verdes.
