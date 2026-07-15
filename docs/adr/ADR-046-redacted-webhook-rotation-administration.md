# ADR-046 — Consulta redigida de rotações de signing secret

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

O ciclo preparar → ativar/cancelar precisa ser observável por pessoas e automações. O registro durável da rotação, porém, contém identificadores internos dos secrets, referência de chave e, enquanto staged, um envelope cifrado recuperável. Uma consulta administrativa não pode aumentar a superfície de exposição desse material nem permitir leitura cruzada entre workspaces ou endpoints.

## Decisão

- A coleção é exposta por `GET /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations` e o item exato por `GET /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}`.
- Ambas exigem autenticação, scope `webhooks:admin` e correspondência simultânea de workspace, endpoint e rotation ID.
- A listagem aceita somente `limit`, `after` e `status`; o cursor opaco incorpora workspace, endpoint e filtro de status, impedindo reutilização em outra consulta.
- A ordenação é estável por `createdAt desc, id desc`, com páginas de até 100 itens.
- O adapter Prisma usa `select` positivo. Somente ID público, endpoint, versão candidata, fingerprint, estado, overlap, revisão-base e timestamps de lifecycle saem da persistência.
- Nunca são selecionados ou apresentados `requestedByClientId`, `previousSecretId`, `candidateSecretId`, `keyRef`, algoritmo do envelope, key ID, nonce, ciphertext ou auth tag.
- O estado apresentado é o estado durável. Um preparo com prazo ultrapassado conserva `status: staged` até um comando ou rotina de manutenção convergir a expiração; `expiresAt` permanece visível para que o consumidor reconheça essa condição sem uma leitura com efeito colateral.
- Item ausente ou fora do escopo retorna o mesmo erro 404 de rotação não encontrada.

## Consequências

- Pessoas, UI e agentes externos conseguem acompanhar e retomar o workflow sem acesso a material criptográfico.
- A consulta é read-only e não produz expiração oportunista escondida.
- `baseRevision` é público nessa visão por ser necessário aos comandos de ativação/cancelamento; ele é um hash de concorrência, não um segredo.
- Uma rotina futura de higiene poderá convergir preparos vencidos e apagar payloads aposentados sem mudar este contrato.

## Evidências exigidas

- cursor rejeitado ao mudar endpoint, workspace ou status;
- leitura exata isolada por workspace e endpoint;
- query Prisma com allowlist de colunas, sem envelope nem referências internas;
- respostas HTTP e exemplos de schema sem campos sensíveis;
- OpenAPI declara as duas capabilities e todos os filtros permitidos;
- regressão unitária, Prisma e HTTP cobre lista, detalhe, 404 e filtro inválido.
