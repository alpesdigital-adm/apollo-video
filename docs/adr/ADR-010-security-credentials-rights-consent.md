# ADR-010 — Segurança, credenciais, rights e consent

> **Status:** Accepted para autenticação externa; rights/consent continuam incrementais
>
> **Data:** 12 de julho de 2026

## Contexto

A Public API já manipula recursos de workspace e precisa ser operável sem acesso direto ao banco. O mecanismo deve permitir credenciais independentes, rotação com overlap curto, revogação imediata e auditoria, sem armazenar bearer secrets recuperáveis.

## Decisão de autenticação externa

- O primeiro mecanismo é uma credencial opaca de service account. OAuth 2.1 será adicionado quando existir delegação de usuário ou integração multiusuário; o domínio continua dependendo de `AuthenticatedExternalActor`.
- Um `ApiClient` é a identidade autorizável. Cada client pode possuir várias `ApiCredential` independentes.
- O bearer token contém somente prefixo, `clientId`, `credentialId` e secret aleatório. Autoridade, workspace, environment, status e scopes são sempre resolvidos server-side.
- O banco armazena apenas salt e hash `scrypt` do secret. O token completo não entra em banco, logs, audit, webhook ou error envelope.
- Criação e rotação retornam o token somente na primeira resposta. Replay idempotente devolve metadata do mesmo recurso com `secretAvailable=false`; perda do primeiro response exige nova rotação.
- Credenciais possuem status, criação, expiração opcional, último uso e revogação. Revogar client invalida todas as credenciais antes da resolução de resources.
- Rotação cria nova credencial antes de expirar/revogar a anterior. O overlap é explícito, curto e limitado pela policy; não há atualização in-place do hash.
- `clients:admin` só opera dentro do workspace autenticado. Um admin só pode conceder scopes que já possui. Rotação da própria credencial é permitida; autoelevação de scopes e autorrevogação destrutiva não são.
- O primeiro client administrativo é criado por bootstrap operacional auditável. Depois disso, clients e credenciais são administrados pela mesma Public API usada pela UI.

## Idempotência e concorrência

- Criação de client e rotação exigem `Idempotency-Key` e request fingerprint.
- A transação grava client/credential e o resultado público no mesmo commit.
- O resultado persistido nunca contém bearer secret.
- Repetir a mesma key e payload retorna o mesmo client/credential; payload diferente retorna conflito.
- Revogação é naturalmente idempotente: repetir a revogação mantém o mesmo estado e não reativa credenciais.

## Rights e consent

O mesmo boundary de autorização receberá rights, consent, finalidade, território e expiração nos slices de Media Library e mídia sintética. Scope nunca substituirá ownership, rights, consent, Policy Snapshot, budget ou estado protegido.

## Consequências

- A migration de credenciais segue expand-contract: cria a tabela nova e migra hashes legados antes de remover colunas antigas em release posterior.
- Credenciais comprometidas podem ser revogadas sem trocar identidade, scopes ou integrações não afetadas.
- O secret store futuro poderá substituir o hash local por referência sem alterar o contrato de domínio.
- Rate limit, audit log persistido, anomaly detection e kill switch de workspace permanecem gates antes de abrir a API amplamente.
