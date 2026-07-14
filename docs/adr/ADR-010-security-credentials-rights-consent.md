# ADR-010 — Segurança, credenciais, rights e consent

> **Status:** Accepted para autenticação externa e primeiro boundary de rights/consent; enforcement global continua incremental
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

Scope nunca substitui ownership, rights, consent, Policy Snapshot, budget ou estado protegido.

- Cada artifact possui zero ou um snapshot corrente `asset-rights/v1` e mantém todas as revisões anteriores imutáveis.
- O hash do snapshot cobre artifact/workspace, owner, license, status, finalidade, proibições, território, locale, operações sintéticas, expiração e consentimento; metadata de criação não altera a identidade do conteúdo.
- Rights e consentimento têm statuses independentes. `unknown`, `restricted`, `expired`, `revoked` ou snapshot ausente bloqueiam uso automático. Consentimento `not-required` precisa ser afirmado explicitamente.
- O workspace permitido é atribuído server-side nesta primeira versão. Um client não concede acesso cross-workspace por payload.
- Evidência de consentimento opcional referencia um artifact existente no mesmo workspace e é protegida por foreign key.
- O primeiro consumidor do gate é a autorização de materialização do RenderInput. O service autentica o payload protegido, valida o target técnico, revalida identidade/disponibilidade dos assets e só então avalia cada snapshot.
- Cada tentativa persiste um aggregate de autorização e uma decisão ordenada por asset, com snapshot/hash, outcome, reason codes, actor, contexto e tempo.
- Autorizações positivas duram no máximo cinco minutos e carregam `revalidationRequired=true`. O worker deve reavaliar o snapshot corrente imediatamente antes de resolver storage e novamente antes de promover o output.
- No início da materialização, o worker relê a autorização por `workspaceId` e ID, rejeita status negado ou validade expirada e autentica novamente o mesmo `RenderInput` ligado ao artifact/manifest autorizados.
- Cada decisão autorizada precisa continuar correspondendo ao mesmo asset, ordinal, kind, snapshot ID e snapshot hash. Uma revisão nova exige nova autorização mesmo quando o novo snapshot também permitiria o uso; não há upgrade silencioso do contexto auditado.
- A avaliação corrente de rights/consent é executada antes de resolver bytes. Expiração durante a leitura também invalida a lease; uma segunda revalidação continuará obrigatória imediatamente antes da promoção do output final.
- O objeto entregue ao renderer encapsula as locations em memória e define serialização segura contendo somente IDs públicos, hashes, contagem e janela de validade.
- Após produzir o partial, o render service repete a materialização autorizada inteira. Somente igualdade de `inputHash` e `revalidationHash`, autorização ainda válida e nova conferência dos bytes permitem a promoção atômica do output.
- O subprocesso Remotion recebe props compiladas por stdin e devolve somente resultado técnico seguro; paths não são argumentos públicos, receipts ou identidade externa.
- `Idempotency-Key` identifica uma tentativa externa. Replay retorna o mesmo receipt; a mesma chave com request diferente falha com conflito.
- Enfileirar render exige autorização emitida para o mesmo API client e vinculada ao artifact/manifest exatos. O contexto protegido fica em `artifact_render_operations`; a `PublicOperation` serializada não contém authorization ID, input hash, canonical key ou location.
- Receipts externos nunca expõem notas jurídicas, props, canonical keys, storage locations, ciphertext ou material criptográfico.

O mesmo evaluator será ligado incrementalmente à busca, Director, geração sintética e export. `restricted` continuará bloqueado para auto-use até existir um workflow administrativo explícito; não há override implícito por scope.

## Consequências

- A migration de credenciais segue expand-contract: cria a tabela nova e migra hashes legados antes de remover colunas antigas em release posterior.
- Credenciais comprometidas podem ser revogadas sem trocar identidade, scopes ou integrações não afetadas.
- O secret store futuro poderá substituir o hash local por referência sem alterar o contrato de domínio.
- O audit de decisão de uso já é persistido; deleção/export do audit, rate limit, anomaly detection e kill switch de workspace permanecem gates antes de abrir a API amplamente.
