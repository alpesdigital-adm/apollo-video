# ADR-047 — Higiene limitada de material criptográfico de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Rotações preparadas e vencidas podem conservar um envelope intermediário até que outro comando observe seu estado. Secrets aposentados deixam de ser utilizáveis no fim exclusivo de `usableUntil`, e secrets revogados são imediatamente terminais, mas seus payloads cifrados permaneciam duráveis. Preservar ciphertext sem utilidade operacional aumenta desnecessariamente o impacto de uma futura exposição do banco.

## Decisão

- A higiene workspace-scoped é exposta por `POST /v1/webhooks/signing-secrets/hygiene`, exige `webhooks:admin` e confirmação humana na capability.
- O body fechado exige `limitPerKind` entre 1 e 100. Cada execução processa no máximo esse total de rotações e esse total de payloads de secrets, evitando transação sem limite.
- Um único `asOf`, capturado antes da persistência, governa toda a execução e é devolvido no resultado.
- Rotações `staged` com `expiresAt <= asOf` passam atomicamente a `expired`, recebem `cancelledAt=asOf` e têm todos os campos do envelope zerados.
- Payloads de secrets `retired` com `usableUntil <= asOf`, ou `revoked`, são apagados fisicamente. O registro de metadata, versão, fingerprint e lifecycle do secret é preservado.
- Secrets `active` e `retired` ainda dentro do overlap nunca são candidatos, mesmo se a execução for repetida ou concorrente.
- A seleção usa somente IDs; ciphertext, nonce, auth tag e referências de chave não são carregados na aplicação nem aparecem na resposta.
- A transação usa isolamento serializável. Conflito concorrente falha de modo explícito e pode ser repetido naturalmente.
- A resposta informa apenas contagens, `asOf` e `hasMore`. Repetição após esgotar os candidatos converge para contagens zero.
- Versões candidatas são monotônicas também após cancelamento/expiração: uma versão reservada nunca é reutilizada.

## Consequências

- Material criptográfico sem possibilidade legítima de uso deixa de permanecer recuperável no banco.
- Histórico administrativo continua disponível pelas consultas redigidas do ADR-046.
- `limitPerKind` pode processar até 200 registros por chamada, distribuídos em duas categorias independentes.
- Automação recorrente futura pode chamar a mesma API até `hasMore=false`, sem precisar acessar tabelas internas.
- A política inicial remove payload aposentado imediatamente após o fim do overlap; retenção forense depende de metadata e logs de auditoria, não do ciphertext.

## Evidências exigidas

- igualdade no limite (`expiresAt == asOf` e `usableUntil == asOf`) já permite higiene;
- rotação vencida perde todo o envelope e mantém metadata consultável;
- payload aposentado/revogado é removido, enquanto payload ativo permanece;
- execução repetida converge sem novo efeito;
- workspace, limite e relógio inválidos falham antes da persistência;
- cancelamento de uma candidata não permite reutilizar sua versão na próxima rotação;
- contratos, Prisma e jornada HTTP não expõem material criptográfico.
