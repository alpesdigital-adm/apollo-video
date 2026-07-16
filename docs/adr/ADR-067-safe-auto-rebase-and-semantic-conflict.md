# ADR-067 — Auto-rebase seguro e conflito semântico

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

O ADR-006 exigia base versionada e rejeitava qualquer command stale. A spec 02
permite auto-rebase quando commands intermediários não tocam os mesmos targets,
mas exige conflito manual e diff quando existe overlap. UI, REST e MCP precisam
usar a mesma decisão, sem comparar JSON bruto ou expor snapshots internos.

## Decisão

- Um resolver puro recebe `EditCommand`, versão-base exata, versão atual e todas
  as edições intermediárias já resolvidas semanticamente.
- O histórico precisa cobrir cada sequence até a versão atual, preservar a cadeia
  de parents e caber numa janela máxima de 1.000 versões. Falta ou fork inesperado
  falha fechado como conflito de persistência.
- Scopes são tratados como seletores conjuntivos. Dimensões explicitamente
  disjuntas não conflitam; project-wide, interseções e dimensões ortogonais que
  podem alcançar o mesmo elemento são tratadas conservadoramente como overlap.
- Ranges são half-open: ranges apenas adjacentes não se sobrepõem.
- Sem overlap, o resultado `auto-rebase` contém o command apontando para ID/hash
  atuais e preserva a base anterior para preview e auditoria. Não há gravação.
- Com overlap, o resultado contém targets canônicos e `VersionDiff` categorizado.
  O handler compartilhado transforma isso em `VERSION_CONFLICT`.
- O error envelope v2 expõe apenas IDs, targets, summaries, artifacts invalidados
  e delta de custo. Um presenter puro aplica allowlist e limites antes do adapter
  Next, removendo payloads, snapshots e campos internos.

## Consequências

- Não existe last-write-wins para commands de projeto.
- O mesmo resolver pode ser usado por UI, Public API e adapter MCP.
- Histórico ausente nunca é interpretado como ausência de conflito.
- A persistência futura pode aplicar a resolução e gravar command, patch, versão
  e outbox atomicamente, mas precisa revalidar a versão atual na transação.

## Evidências exigidas

- base exata sem rebase;
- auto-rebase com scopes disjuntos e diff agregado;
- conflito com track e range sobrepostos;
- rejeição de lacuna de sequence e parent inconsistente;
- redaction de campos internos no envelope público;
- schema v2, exemplo e OpenAPI validados;
- regressão completa verde.
