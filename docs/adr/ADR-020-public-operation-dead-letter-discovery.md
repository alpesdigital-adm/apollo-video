# ADR-020 — Descoberta administrativa de dead-letter

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O worker já distingue falha não recuperável de esgotamento de retries por meio de `deadLetteredAt`. O retry manual reabre uma operação conhecida, mas operadores e agentes ainda não conseguem descobrir quais operações esgotaram a capacidade automática sem acesso direto ao banco.

Adicionar um filtro opcional à capability de listagem existente alteraria um contrato já publicado. Também deixaria ambígua a diferença entre uma falha definitiva e uma operação que pode ser considerada para replay operacional.

## Decisão

- A descoberta usa uma capability aditiva própria: `apollo.operations.dead-letter.list` em `GET /v1/operations/dead-letter`.
- O endpoint exige `operations:read`, pois devolve o mesmo conjunto de campos seguros já acessível na listagem geral, apenas selecionado pelo checkpoint interno de esgotamento.
- Somente operações com `status = failed` e `deadLetteredAt IS NOT NULL` participam. Falhas não recuperáveis sem marca de esgotamento ficam de fora.
- O response reutiliza `public-operation-list/v1`. `deadLetteredAt`, schedule, lease, authorization, RenderInput e storage permanecem internos.
- `completedAt` continua sendo o timestamp terminal público; pela invariável de persistência ele coincide com o checkpoint de dead-letter, sem criar um novo campo no schema v1.
- Paginação preserva `createdAt DESC, id DESC`, limite máximo 100 e cursor vinculado ao workspace, aos filtros, ao status `failed` e ao modo dead-letter.
- Os filtros externos permitidos são `type` e `targetId`. `status` não é aceito porque a semântica da rota já o fixa.
- Parâmetros desconhecidos, repetidos, cursor incompatível e valores fora da allowlist falham com `INVALID_ARGUMENT`.
- Um índice workspace/dead-letter/criação/ID sustenta a seleção no PostgreSQL e no protótipo SQLite.
- A ação de replay permanece no command individual `POST /v1/operations/{operationId}/retry`, com scope e confirmação próprios. A listagem nunca reexecuta trabalho.

## Consequências

- Um retry aceito limpa `deadLetteredAt` na mesma transação que reabre a operação; consultas posteriores deixam de listá-la.
- Listagem e retry concorrentes podem observar o estado anterior ou posterior de acordo com a ordem de commit, sem produzir reabertura dupla.
- A capability informa elegibilidade operacional para avaliação humana, não garante que rights, consent, autorização, quota ou provider ainda permitam concluir a nova tentativa.
- Não existe retry em lote, replay automático, retenção, purge ou reconhecimento manual nesta etapa.
- Métricas agregadas, alertas, ator/motivo, custo e audit/event outbox continuam necessários para uma console operacional completa.

## Evidências exigidas

- dead-letter incluído e falha definitiva excluída;
- isolamento por workspace e filtros por tipo/alvo;
- paginação com cursor vinculado ao modo dead-letter;
- scope negado e parâmetros fora da allowlist rejeitados;
- payload sem checkpoint ou contexto protegido;
- fluxo listar → retry → remoção da listagem administrativa.
