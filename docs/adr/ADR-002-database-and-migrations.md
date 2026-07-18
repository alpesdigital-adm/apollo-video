# ADR-002 — Banco, persistência v2 e migrations

## Retention, vector search e limites operacionais

- Operações, tentativas e auditoria redigida ficam 90 dias online e depois seguem a política versionada do workspace. Versões, decisões de direitos e lineage acompanham o projeto, salvo deleção verificada.
- PostgreSQL 16 com pgvector foi escolhido porque a busca precisa pré-filtrar workspace, direitos, consentimento, tipo e metadata. Embeddings guardam modelo, versão, dimensões, hash e revisão de elegibilidade; mudança de dimensão cria índice aditivo.
- O limite inicial é um milhão de segmentos elegíveis por workspace e 2.000 candidatos antes do reranking. Particionamento ou outro motor exige métricas e novo ADR.
- Custo de storage, índices vetoriais, retenção e cardinalidade de embeddings aparece nas métricas do workspace.

> **Status:** Accepted para a Fundação
>
> **Data:** 12 de julho de 2026

## Contexto

A v1 usa SQLite e um `Project` monolítico. A v2 exige isolamento por workspace, versões imutáveis, transações, outbox, busca vetorial e jobs duráveis. O PRD define Postgres como alvo e permite SQLite apenas em protótipos locais.

## Decisão

- Postgres será o banco de produção da v2.
- pgvector ou equivalente no Postgres será decidido junto do pipeline de percepção.
- Domínio e application services dependem de repository ports, nunca de Prisma.
- Prisma permanece como adapter inicial de persistência.
- Durante a transição, tabelas `v2_*` portáveis podem ser exercitadas no SQLite local existente.
- Nenhuma decisão dependente de SQLite — JSON serializado, ausência de constraint, locking global ou path local — entra no domínio.
- Antes do primeiro ambiente compartilhado, haverá datasource Postgres, migrations versionadas e teste sobre snapshot.
- Commands, ProjectVersion, snapshots e idempotency record que pertencem à mesma mutação serão gravados em uma transação.

## Política de migration e rollback

- Prisma Migrate é a ferramenta canônica do schema Postgres v2.
- `prisma/v2/migrations` é versionado e `migrate deploy` é o único comando permitido em ambiente compartilhado.
- `db push` permanece restrito ao SQLite local descartável.
- Antes de cada deploy com migration: backup/PITR verificado, migration check no CI e ensaio em snapshot compatível.
- Enquanto o banco v2 estiver vazio, rollback da migration inicial pode recriar o database/schema isolado.
- Depois de existirem dados, não haverá down migration destrutiva automática: rollback significa interromper writers, restaurar snapshot/PITR e reimplantar a versão anterior da aplicação.
- Migration incompatível será expand/contract em releases separadas.

## Primeiro slice

Criar tabelas v2 para Workspace, Project, ProjectSnapshot, ProjectVersion e IdempotencyRecord; implementar um repository Prisma atrás de port e validar o caso de uso também com adapter em memória.

## Consequências

- A v1 pode continuar usando a mesma instância Prisma durante a transição local.
- `db push` é aceito apenas para este protótipo local; produção exigirá migrations revisadas.
- Persistência de snapshots começa como JSON canônico em texto para manter portabilidade; consulta estruturada virá de projeções/tabelas próprias.
- A troca do datasource não muda contratos públicos nem regras do domínio.
- Produção falha com `PERSISTENCE_NOT_CONFIGURED` enquanto Postgres não estiver configurado; nunca cai silenciosamente para SQLite.

## Estado implementado na Fundação

- Postgres 16 foi provisionado em instância e volume exclusivos do Apollo; nenhum banco de outro produto é compartilhado.
- A porta do banco fica restrita ao loopback da VPS. Desenvolvimento e operações administrativas conectam por túnel SSH.
- `V2_DATABASE_URL` é fornecida somente por arquivos/secret stores ignorados pelo Git.
- A migration inicial foi aplicada com `prisma migrate deploy` e validada por inspeção do schema real, teste transacional e integração HTTP em modo de produção.
- Os repositories são resolvidos no boundary de infraestrutura: produção exige o client Postgres v2; SQLite continua disponível somente quando selecionado explicitamente como protótipo local.
- Como o banco estava vazio na primeira migration, o rollback permitido era recriar banco/schema. Backup automatizado e restore drill passam a ser gate antes de dados insubstituíveis ou da próxima migration compartilhada.
