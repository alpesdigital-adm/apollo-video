# ADR-142 — Identidade humana, sessão e recuperação

> **Status:** Accepted
>
> **Data:** 2 de agosto de 2026

## Contexto

O Apollo já publica login, leitura de sessão e logout em `/v1/session`, mas a implementação inicial usa um único usuário configurado por ambiente, hash scrypt e cookie assinado autocontido. Isso é suficiente apenas para desenvolvimento isolado: não representa uma identidade humana verificável, não oferece revogação individual durável, não modela membership e não define recuperação de conta. Automações já possuem uma fronteira separada por Bearer de `ApiClient`; misturar os dois mecanismos permitiria que senha humana ou sessão de navegador chegassem a agentes.

## Decisão

- Produção usa um provedor OIDC gerenciado por Authorization Code com PKCE, `state` e `nonce`. Somente claims de uma issuer/audience allowlisted e assinatura verificada podem criar identidade Apollo.
- A credencial humana nunca é recebida, armazenada ou redefinida pelo Apollo. O formulário username/password atual é bootstrap exclusivo de desenvolvimento isolado e bloqueia o gate de produção até ser substituído pelo adapter OIDC.
- O retorno OIDC resolve uma identidade externa imutável (`issuer + subject`) para `WorkspaceMember` ativo. Email é atributo mutável e não é chave de autorização.
- A sessão de produção é server-side e durável no PostgreSQL. O navegador recebe apenas um identificador aleatório opaco; o banco preserva somente seu hash, identidade, workspace ativo, emissão, última atividade, expiração, rotação e revogação.
- O cookie é `HttpOnly`, `Secure`, `SameSite=Strict`, path `/`, sem token OIDC. A sessão possui timeout ocioso de 30 minutos, expiração absoluta de 12 horas e rotação do identificador a cada elevação/troca de workspace e no máximo a cada 15 minutos. Nenhuma atividade estende a expiração absoluta.
- Logout revoga a sessão no servidor antes de expirar o cookie. Suspensão de member, remoção do workspace, revogação administrativa e eventos OIDC suportados revogam todas as sessões relacionadas.
- Recuperação de credencial pertence ao IdP. O Apollo não publica password reset, recovery token ou pergunta secreta. Após recuperação no IdP, o mesmo `issuer + subject` recupera memberships existentes; mudança de subject exige re-vinculação explícita e auditada por administrador ativo do workspace.
- Acesso emergencial é responsabilidade de contas break-glass no IdP, protegidas por MFA e auditadas. Não existe senha mestra, fallback local, compartilhamento de senha com agente ou downgrade silencioso para o bootstrap.
- `apollo.sessions.login/read/logout` são contratos humanos sem `toolName`. O capability registry falha fechado se qualquer capability `apollo.sessions.*` tentar virar ferramenta; MCP e Diretor derivam exclusivamente o catálogo com `toolName`.
- `password` permanece `writeOnly` enquanto o bootstrap existir e é proibido em response, log, telemetria, evento e outbox. A remoção do bootstrap publicará uma evolução aditiva do contrato, sem reaproveitar o campo como token OIDC.

## Consequências

- Esta decisão fecha a seleção do mecanismo, expiração e recuperação. O bootstrap transitório agora usa sessão revogável, idle timeout, throttle distribuído e audit redigido no PostgreSQL; isso não afirma que OIDC, identificador opaco rotacionável, `WorkspaceMember` ou E2E de troca de workspace já estejam implementados.
- Deploy de produção permanece bloqueado enquanto `/v1/session` aceitar apenas o bootstrap local ou enquanto as páginas V2 não exigirem a sessão durável no boundary server-side.
- Bearer de `ApiClient` continua sendo a única autenticação de automação; cookie humano não autentica MCP nem worker.

## Evidências exigidas para implementação

- callback OIDC com issuer/audience/signature/state/nonce/PKCE verificados;
- sessão PostgreSQL revogável, rotação, idle/absolute timeout e cleanup;
- membership ativo e troca de workspace sem cache/subscription residual;
- recuperação exercitada no IdP sem criar endpoint de password reset Apollo;
- testes provando que senha/cookie/token não chegam a tools, logs, eventos ou telemetria;
- E2E de expiração, logout, suspensão, revogação, acesso negado e isolamento entre workspaces.

## Evidência incremental

O run hospedado `30766068302` (attempt 2) aplicou as tabelas de sessão, throttle e tentativas em PostgreSQL limpo e passou 808 testes, contratos, build, integrações e goldens. Duas instâncias do repository observaram a mesma revogação e janela de brute force; o E2E HTTP confirmou que logout invalida o cookie anterior, a sexta tentativa falha retorna `429`, a senha correta permanece bloqueada durante a janela e o audit não persiste username nem senha. O cookie assinado ainda serve somente como envelope transitório e triagem do Proxy; OIDC, rotação e proteção server-side das páginas permanecem gates abertos.
