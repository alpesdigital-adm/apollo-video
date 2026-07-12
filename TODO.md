# Apollo Video v2 — Backlog executável

> **Fonte principal:** [`docs/PRD-APOLLO-V2.md`](./docs/PRD-APOLLO-V2.md), versão 1.1  
> **Rastreabilidade:** [`docs/REQUIREMENTS-TRACEABILITY.md`](./docs/REQUIREMENTS-TRACEABILITY.md)  
> **Especificações:** [`docs/specs`](./docs/specs)  
> **Estado:** backlog inicial; nenhuma caixa marcada sem evidência verificável  
> **Unidade:** uma microtarefa deve produzir um artefato revisável e, em geral, caber em até um dia de trabalho

---

## 0. Como executar este backlog

### 0.1 Regras de uso

- [ ] Antes de iniciar uma microtarefa, confirmar as dependências citadas no FR, ADR ou spec correspondente.
- [ ] Associar cada implementação a um ID deste arquivo e ao FR/NFR/AC de origem no PR ou commit.
- [ ] Nomear a evidência principal de cada requisito como `T-FR-xxx`, conforme a matriz, e vincular testes adicionais ao mesmo ID.
- [ ] Não marcar uma tarefa de implementação sem teste, fixture, captura ou métrica que demonstre o resultado.
- [ ] Quando uma decisão mudar contrato, atualizar PRD, spec, matriz, migration e testes no mesmo PR.
- [ ] Tratar valores indicados como “inicial”, “default” ou “a calibrar” como configuração versionada, não constante dispersa.
- [ ] Abrir um ADR quando a implementação exigir decisão diferente das questões já listadas no PRD.
- [ ] Entregar slices verticais pequenos: domínio → persistência → job/provider → UI → observabilidade → teste.
- [ ] Manter masters imutáveis e executar toda transformação por derivado com lineage.
- [ ] Fazer UI e IA emitirem o mesmo modelo de `Command`; não criar mutações paralelas fora do domínio.
- [ ] Exigir que toda capability operável possua contrato público, capability ID e contract test; UI, API e agentes usam o mesmo application service.
- [ ] Impedir que transcrição, OCR, metadados ou documentos enviados sejam interpretados como instruções do proprietário.

### 0.2 Definition of Ready de uma microtarefa

- [ ] Resultado esperado e estado de erro estão escritos.
- [ ] Contrato de entrada/saída e owner do dado estão identificados.
- [ ] Dependências técnicas e de produto estão resolvidas ou explicitamente mockadas.
- [ ] Fixture, caso de teste ou procedimento de validação está definido.
- [ ] Impacto em rights, consent, custo, lineage e invalidação foi avaliado.

### 0.3 Definition of Done global

- [ ] Contrato e migration afetados possuem versão.
- [ ] Permissões, rights e isolamento de workspace foram verificados.
- [ ] Operações repetíveis possuem idempotency key e comportamento de retry definido.
- [ ] UI possui loading, empty, error, retry e cancel quando aplicável.
- [ ] Logs, métricas e correlation IDs foram adicionados sem expor conteúdo sensível.
- [ ] Regra de domínio possui teste unitário.
- [ ] Integração externa possui adapter mockado e contract test.
- [ ] Fluxo visual/timing possui E2E, golden ou fixture determinística.
- [ ] Dashboard/editor representam o estado verdadeiro do workflow.
- [ ] Versionamento, lineage, proteção e invalidação parcial foram exercitados.
- [ ] Critério de aceite local foi demonstrado.
- [ ] Segurança não depende exclusivamente de prompt.

### 0.4 Ordem macro

- [ ] Concluir decisões bloqueantes e Fundação (F0).
- [ ] Entregar MVP Core ponta a ponta (F1) antes de ampliar variações.
- [ ] Adicionar lotes, reuso e formatos (F2).
- [ ] Adicionar mídia sintética e transformação (F3).
- [ ] Adicionar multicâmera e long-form avançado (F4).
- [ ] Adicionar localização e áudio avançado (F5).
- [ ] Executar o gate da fase anterior antes de habilitar a próxima para usuários.

---

## 1. Produto, UX e decisões prévias

### 1.1 Princípios P-01 a P-10

- [ ] [P-01] Documentar quais decisões pertencem à IA e quais validações permanecem determinísticas em código.
- [ ] [P-02] Proibir qualquer fluxo que descarte áudio, vídeo, imagem ou saída sintética antes de aplicar retention policy.
- [ ] [P-03] Remover seleção manual obrigatória de “estilo” e fazer o `TreatmentPlan` determinar o tratamento visual.
- [ ] [P-04] Implementar precedência “reutilizar → adaptar → gerar → omitir” nas decisões de assets.
- [ ] [P-05] Permitir explicitamente `no_insert`, `no_effect` e `no_music` como decisões válidas.
- [ ] [P-06] Exigir critic/validator para toda geração antes de promovê-la a artifact aprovável.
- [ ] [P-07] Registrar decisão, evidência, confidence, custo e alternativa em todo `DirectorRun`.
- [ ] [P-08] Garantir edição manual, proteção, undo e restore sem bifurcar o modelo de estado.
- [ ] [P-09] Traduzir guardrails livres em políticas estruturadas e versionadas.
- [ ] [P-10] Manter contratos amplos, mas liberar capacidades apenas pelos gates incrementais F0–F5.
- [ ] [P-11] Expor externamente toda capacidade operável sem publicar internals nem permitir bypass de policies.

### 1.2 Papéis e permissões

- [ ] Definir matriz de permissões para operador/editor, diretor/estrategista, administrador e revisor.
- [ ] Definir ações somente leitura, mutações editoriais, mutações de workspace e ações financeiras por papel.
- [ ] Definir quem pode desbloquear `ProtectedElement`, alterar rights, consent e guardrails.
- [ ] Definir quem pode aprovar final, cancelar job pago e exportar master/final.
- [ ] Criar fixtures de autorização para todos os papéis e estados do projeto.
- [ ] Testar negação server-side; ocultar botão na UI não conta como autorização.

### 1.3 Design system e referências visuais

- [ ] Extrair tokens de cor, tipografia, espaçamento, elevação e raio dos dois mockups aprovados.
- [ ] Definir componentes de status para queued, running, review, failed, stale, completed e archived.
- [ ] Definir padrões de empty state, skeleton, progress indeterminado, erro recuperável e conflito.
- [ ] Criar primitives para sidebar, project card, media rail, preview, timeline, inspector e Director panel.
- [ ] Criar padrões para `ImpactPreview`, confirmação de custo, diff, issue e annotation.
- [ ] Verificar contraste, foco, teclado, reduced motion e targets de interação conforme spec 07.
- [ ] Criar visual regression das telas de workspace e editor nas resoluções de referência.

### 1.4 ADRs bloqueantes

#### ADR-001 — Estrutura do repositório v2

- [ ] Inventariar módulos, dependências e acoplamentos da v1.
- [ ] Comparar monorepo, modular monolith e serviços separados para domínio, workers e renderer.
- [x] Definir fronteiras de packages, imports permitidos e ownership. Evidência: `ADR-001` e boundary `src/v2`.
- [x] Registrar estratégia de migração seletiva sem preservar rotas monolíticas. Evidência: `ADR-001`.

#### ADR-002 — Banco, vector search e migrations

- [ ] Comparar Postgres/pgvector e alternativas compatíveis com os filtros da Media Library.
- [ ] Definir migration tool, política de rollback e teste em snapshot de produção futura.
- [ ] Definir isolamento por workspace, índices, retenção e versionamento de embeddings.
- [ ] Registrar decisão com estimativa de custo e limites operacionais.

#### ADR-003 — Object storage e content addressing

- [ ] Selecionar object storage para desenvolvimento, preview e produção.
- [ ] Definir checksum, canonical key, multipart upload e verificação de integridade.
- [ ] Definir signed URLs, lifecycle, replicação e separação master/derivative.
- [ ] Registrar comportamento de dedupe dentro e entre workspaces.

#### ADR-004 — Workflow e fila durável

- [ ] Comparar mecanismos de workflow quanto a resume, retry, heartbeat, cancel e fan-out.
- [ ] Definir estado canônico do job, idempotency key e outbox/event delivery.
- [ ] Definir execução local, worker de mídia e callback de provider.
- [ ] Registrar SLAs, timeout e política de dead-letter/replay.

#### ADR-005 — EditPlan v2

- [ ] Congelar schema mínimo, version field, migrations e invariantes de tempo.
- [ ] Definir separação entre plano canônico, locale e formato.
- [ ] Definir compiler para `RenderInput` sem acesso implícito ao banco.
- [ ] Criar três fixtures versionadas e validar round-trip/migration.

#### ADR-006 — Command/Patch model

- [ ] Definir command envelope, scope, preconditions, patch operations e transaction result.
- [ ] Definir optimistic concurrency, auto-rebase e conflito por target overlap.
- [ ] Definir undo/redo/restore como novas operações auditáveis.
- [ ] Criar property tests para aplicação determinística e inversão permitida.

#### ADR-007 — Provider adapter e capability registry

- [ ] Definir capability descriptor, pricing, limits, health e region.
- [ ] Definir adapter contract para submit, poll, cancel, callback e normalize result.
- [ ] Definir seleção e fallback sem expor provider ao domínio.
- [ ] Criar provider fake que simule sucesso, demora, rate limit e falha permanente.

#### ADR-008 — Render architecture e cache

- [ ] Definir responsabilidades de Remotion, FFmpeg e compositor futuro.
- [ ] Definir `RenderInput`, cache keys, proxy/final e range render.
- [ ] Definir isolamento do renderer e limites de memória/CPU/GPU.
- [ ] Criar smoke render reproduzível a partir de manifest.

#### ADR-009 — Perception pipeline e metadata tiers

- [ ] Definir sinais obrigatórios por tier e quais modelos geram cada campo.
- [ ] Separar observado, inferido, humano e derivado no schema.
- [ ] Definir processamento hierárquico e reprocessamento por model version.
- [ ] Definir eval set e limiares mínimos para promoção de metadados.

#### ADR-010 — Segurança, credenciais, rights e consent

- [ ] Definir secret store, rotação, escopo e acesso de workers.
- [ ] Modelar direitos, consentimento, finalidade, território e expiração.
- [ ] Definir audit log, deleção e exportação de dados.
- [ ] Fazer threat model de upload, prompt injection, SSRF e webhook forgery.

#### ADR-011 — Model routing e observabilidade

- [ ] Definir catálogo de modelos, capabilities, custo, latency e fallback.
- [ ] Definir tracing por `DirectorRun`, job e provider call.
- [ ] Definir política de redaction e amostragem de prompts/respostas.
- [ ] Definir dashboards de custo, qualidade, erro e tempo por fase.

#### ADR-012 — Estado da UI e revisão colaborativa

- [ ] Definir server state, estado transitório da timeline e optimistic updates.
- [ ] Definir transporte de eventos de jobs e recuperação após reconnect.
- [ ] Definir conflito de edição e escopo da colaboração no MVP.
- [ ] Criar protótipo de annotation → impact preview → nova versão.

#### ADR-013 — API pública, autenticação externa, webhooks e MCP

- [ ] Decidir OAuth 2.1, signed service keys ou ambos e definir rotação/revogação.
- [x] Definir source of truth de OpenAPI, capability registry, SDKs e tool schemas. Evidência: `ADR-013`.
- [ ] Definir versionamento, depreciação, sunset e retenção de schemas/events.
- [ ] Definir entrega/assinatura/replay de webhooks e ordenação por resource.
- [ ] Definir confirmação de ações caras/destrutivas e transporte do MCP oficial.
- [ ] Registrar rate limits, quotas e fronteira do gateway público.

---

## 2. Fase 0 — Fundação e especificação executável

**Gate da fase:** shell navegável, domínio persistido, upload imutável, workflow retomável e smoke render v2 reconstruível.

### F0.001 — Workspace [FR-001]

- [ ] Modelar `Workspace`, status, owner, timestamps e settings versionados.
- [ ] Criar migration, repository e constraints de unicidade/isolamento.
- [ ] Resolver `workspaceId` server-side em toda request e job.
- [ ] Criar workspace inicial e seletor sem permitir acesso cruzado.
- [ ] Testar leitura, escrita e job com dois workspaces concorrentes.

### F0.002 — Brand Kit opcional [FR-020]

- [ ] Modelar cores, logos, handles, profissional, empresa, vinheta e instruções de marca como campos opcionais.
- [ ] Armazenar assets de marca com rights, checksum e lineage.
- [ ] Implementar resolução segura de kit vazio, parcial e completo.
- [ ] Testar que ausência de Brand Kit não bloqueia criação, direção ou render.

### F0.003 — Guardrails estruturados [FR-022]

- [ ] Definir schema de allow, deny, require, disclosure e escalation.
- [ ] Implementar compiler de instruções do owner para regras estruturadas revisáveis.
- [ ] Separar conteúdo ingerido de canais autorizados de instrução.
- [ ] Criar policy tests para claims, prova, mídia sintética e marca.

### F0.004 — Precedência de políticas [FR-023]

- [ ] Codificar ordem legal/plataforma → workspace → projeto → briefing → preferência aprendida.
- [ ] Gerar conflito explícito quando regras de mesmo nível forem incompatíveis.
- [ ] Persistir regra vencedora e justificativa no decisions log.
- [ ] Testar matriz de conflitos e impedir override de nível superior.

### F0.005 — Policy Snapshot [FR-024]

- [ ] Definir snapshot imutável com versões de policies, Brand Kit e consentimentos.
- [ ] Anexar snapshot a `ProjectVersion`, `DirectorRun` e render manifest.
- [ ] Impedir alteração retroativa quando workspace settings mudarem.
- [ ] Testar reprodução de versão antiga com policy antiga.

### F0.006 — Masters imutáveis [FR-031]

- [ ] Definir estados de upload, verification, ready, quarantined e deleted.
- [ ] Bloquear update de bytes ou storage key após confirmação do master.
- [ ] Gerar toda normalização, proxy e transformação como derivative.
- [ ] Testar tentativa de sobrescrita e preservação do master original.

### F0.007 — Content addressing e deduplicação [FR-032]

- [ ] Calcular checksum durante upload sem carregar arquivo inteiro em memória.
- [ ] Criar canonical object key e unique constraint compatível com o escopo aprovado.
- [ ] Reutilizar bytes existentes mantendo referência e direitos por workspace.
- [ ] Testar upload duplicado, upload interrompido e colisão simulada.

### F0.008 — Normalização com lineage [FR-033]

- [ ] Definir recipe versionada para codec, container, áudio, resolução e frame rate.
- [ ] Criar job idempotente de probe e normalize.
- [ ] Persistir parent asset, recipe, tool version, checksum e output metadata.
- [ ] Testar rerun, falha parcial e reconstrução do derivado.

### F0.009 — Preservação de timebase [FR-034]

- [ ] Persistir PTS/DTS, timebase, frame rate nominal/real e duração antes da normalização.
- [ ] Definir conversões explícitas entre source time, session time e timeline frame.
- [ ] Criar fixtures VFR, CFR, áudio deslocado e início negativo.
- [ ] Validar round-trip source frame ↔ timeline frame dentro da tolerância da spec 05.

### F0.010 — Direitos [FR-035]

- [ ] Modelar owner, license, permitted uses, territory, expiry, consent e status unknown/restricted.
- [ ] Criar gate central consultado por busca, Director, geração, render e export.
- [ ] Bloquear uso quando direitos forem ausentes ou incompatíveis; permitir revisão autorizada.
- [ ] Registrar cada decisão de uso e testar expiração durante projeto ativo.

### F0.011 — Tipos de ativos [FR-041]

- [ ] Criar enum extensível para video, audio, image, document, synthetic e derivados previstos.
- [ ] Definir campos comuns e metadata específica sem tabela JSON sem contrato.
- [ ] Validar schemas em API, worker e banco.
- [ ] Criar contract fixtures para todos os kinds do PRD.

### F0.012 — EditPlan versionado [FR-070]

- [ ] Implementar schema v2 conforme spec 02 com `schemaVersion` obrigatório.
- [ ] Criar parser/validator que rejeite references, ranges e overlaps inválidos.
- [ ] Implementar registry de migrations puras entre versões.
- [ ] Criar golden files para parse, compile, migrate e serialize.

### F0.013 — Tracks [FR-071]

- [ ] Implementar track types, ordering, exclusivity, visibility, mute e lock.
- [ ] Codificar políticas de overlap por tipo de track.
- [ ] Compilar tracks para renderer somente a partir do plano resolvido.
- [ ] Testar base video, audio, B-roll, overlay, subtitle, color e annotation.

### F0.014 — Source ranges [FR-072]

- [ ] Modelar `sourceIn/sourceOut`, `timelineIn/timelineOut`, rate e mapping.
- [ ] Impedir range negativo, invertido ou além da duração conhecida.
- [ ] Implementar trim/split preservando source mapping.
- [ ] Criar property tests em frame rates e timebases distintos.

### F0.015 — Múltiplas fontes [FR-073]

- [ ] Permitir que um EditPlan referencie N assets e segmentos por ID imutável.
- [ ] Resolver references em etapa explícita antes do render.
- [ ] Detectar source ausente, sem direito ou ainda não processado.
- [ ] Testar plano com talking head, B-roll, imagem, áudio e overlay.

### F0.016 — Commands e Patches [FR-074]

- [ ] Implementar envelope com actor, base version, scope, preconditions e operations.
- [ ] Criar command handlers puros para operações fundamentais.
- [ ] Persistir command e nova version na mesma transação.
- [ ] Fazer ações manuais e ferramentas do Diretor passarem pelo mesmo handler.
- [ ] Testar idempotência, validação, rollback e concorrência.

### F0.017 — Protected elements [FR-075]

- [ ] Modelar proteção por element, range, reason, owner e expiry opcional.
- [ ] Consultar proteção antes de patch manual, IA, batch ou localization.
- [ ] Criar fluxo autorizado de desbloqueio com audit log.
- [ ] Testar tentativa direta, indireta e por invalidação dependente.

### F0.018 — Dependency graph [FR-076]

- [ ] Enumerar nós de source, transcript, perception, plans, variants, proxy e final.
- [ ] Definir edges e regras de invalidação determinísticas por command type.
- [ ] Calcular conjunto mínimo afetado antes de enfileirar jobs.
- [ ] Criar testes de snapshot para a matriz de invalidação da spec 02.

### F0.019 — OutputSpec [FR-161]

- [ ] Implementar aspect ratio, width, height, fps, safe areas, codec e delivery constraints.
- [x] Validar combinações incompatíveis e defaults por destino. Evidência: `output-spec.ts` e testes dos cinco presets.
- [ ] Versionar `OutputSpec` dentro de cada ProjectVersion.
- [x] Criar schema fixtures para os cinco formatos obrigatórios. Evidência: `OUTPUT_PRESETS` e `domain-contracts.test.mjs`.

### F0.020 — Plano canônico e variantes [FR-162]

- [ ] Separar Story/Edit plan canônico de `FormatVariantPlan` e `LocalizationVariant`.
- [ ] Definir o que é compartilhado e o que pode divergir por formato/locale.
- [ ] Propagar mudanças canônicas somente aos dependentes não protegidos.
- [ ] Testar que um crop 9:16 não altera 16:9.

### F0.021 — ProjectVersion [FR-220]

- [ ] Modelar versão imutável, parent, author, reason, status e snapshots associados.
- [ ] Criar nova versão para toda mudança confirmada.
- [ ] Tornar current version atualização transacional e concorrente.
- [ ] Testar branching, versão stale e leitura histórica.

### F0.022 — Fork copy-on-write [FR-221]

- [ ] Criar command de duplicação que referencia masters e derivatives reutilizáveis.
- [ ] Copiar somente planos/settings mutáveis e registrar `forkedFrom`.
- [ ] Separar status, jobs, annotations e aprovações do novo projeto.
- [ ] Medir e testar que duplicação não copia bytes de mídia.

### F0.023 — Isolamento do fork [FR-222]

- [ ] Impedir commands do fork de alterar versão, status ou artifacts do original.
- [ ] Resolver referências compartilhadas como read-only.
- [ ] Testar edição, delete, render e archive nos dois projetos.
- [ ] Exibir lineage sem sugerir sincronização automática entre forks.

### F0.024 — Diff e restore [FR-223]

- [ ] Criar diff semântico para story blocks, clips, layout, texto, áudio e settings.
- [ ] Implementar restore como nova versão, sem apagar histórico.
- [ ] Mostrar impacto e jobs invalidados antes do restore.
- [ ] Testar compare/restore entre versões compatíveis e migradas.

### F0.025 — Artifact lineage [FR-224]

- [ ] Modelar grafo de artifact → version → plan → sources → jobs/providers.
- [ ] Persistir hashes e versões de tool/model em cada edge.
- [ ] Criar endpoint de inspeção e incluir resumo no manifest.
- [ ] Testar reconstrução e diagnóstico de artifact final.

### F0.026 — Durable jobs [FR-232]

- [ ] Implementar job state machine, heartbeat, attempt e idempotency key.
- [ ] Persistir checkpoints antes e depois de efeitos externos.
- [ ] Implementar retry exponencial, cancelamento e dead-letter.
- [ ] Simular restart entre cada checkpoint e verificar retomada segura.

### F0.027 — Partial invalidation [FR-233]

- [ ] Mapear cada command aos ranges, variants e artifacts afetados.
- [ ] Marcar somente dependentes como stale.
- [ ] Enfileirar proxy/range render mínimo e manter outputs válidos.
- [ ] Testar alteração de legenda, crop, B-roll e source transcript.

### F0.028 — Props e manifest [FR-234]

- [ ] Definir `RenderInput` autocontido e schema versionado.
- [ ] Materializar URLs/paths, fonts, LUTs e assets antes de iniciar render.
- [ ] Salvar manifest com checksums, plan hash e renderer version.
- [ ] Reexecutar golden render somente a partir do manifest salvo.

### F0.029 — Estados visíveis [FR-236]

- [ ] Definir estados válidos de projeto, versão, job, item batch e artifact.
- [ ] Implementar transições server-side e rejeitar saltos inválidos.
- [ ] Mapear estado técnico para label, progresso e ação na UI.
- [ ] Testar sucesso, espera, retry, cancel, falha parcial, stale e conclusão.

### F0.030 — Infraestrutura e smoke vertical

- [ ] Provisionar Postgres, object storage e workflow em desenvolvimento isolado.
- [ ] Criar seeds mínimos para workspace, projeto, source e OutputSpec.
- [ ] Configurar lint, typecheck, unit, integration, golden e E2E no CI.
- [ ] Criar telemetria comum com trace, job, workspace e project IDs.
- [ ] Fazer upload de fixture, normalizar, criar plano estático e renderizar proxy.
- [ ] Reconstruir o proxy usando apenas banco, object storage e manifest.

### F0.031 — Autenticação, shell e navegação

- [ ] Selecionar mecanismo de autenticação e documentar sessão, expiração e recuperação de conta.
- [ ] Implementar sign-in/sign-out e proteção server-side das rotas v2.
- [ ] Criar `WorkspaceMember` a partir de identidade autenticada e papel ativo.
- [ ] Implementar shell com navegação para projetos, lotes, biblioteca, apresentadores, marca e settings.
- [ ] Implementar seletor de workspace que invalide caches e subscriptions do workspace anterior.
- [ ] Criar E2E de sessão expirada, acesso negado e troca de workspace sem vazamento de dados.

### F0.032 — Fronteiras da arquitetura lógica

- [ ] Isolar Web/Editor para consumir queries, commands e events sem acessar banco/storage diretamente.
- [ ] Isolar Application API em auth, domínio, queries, commands e job control.
- [ ] Isolar Orchestrator de Ingest, Perception, Director, Provider, Critic e Render workers.
- [ ] Definir interfaces entre Provider Registry, Director, Compiler, Renderer e Critics.
- [ ] Adicionar regras de import/lint que impeçam dependências invertidas entre camadas.
- [ ] Criar architecture tests e um fluxo fake atravessando todos os componentes.

### F0.033 — Modelo conceitual e tecnologia-alvo

- [ ] Mapear todas as entidades das seções 10.1–10.6 para aggregates, tabelas e value objects, sem implementar tabela genérica sem contrato.
- [ ] Definir relações, ownership, lifecycle e chaves de Workspace, Project, Media, Capture, Synthetic e Execution.
- [ ] Validar que `SourceAsset`, `TimelineSegment`, `OutputSpec`, adapter e `EditCommand` são compatíveis com as specs 02, 03 e 06.
- [ ] Fixar versões-alvo de Next.js/React, Remotion, FFmpeg/ffprobe, Postgres/vector e client libraries no ADR-001/002/008.
- [ ] Configurar S3-compatible storage e impedir SQLite como domínio final fora de protótipos locais.
- [ ] Gerar diagrama/schema documentation e testar integridade referencial dos aggregates centrais.

### F0.034 — Paridade API-first [FR-240]

- [x] Criar `PublicCapability` registry com exposure, scopes, schema, custo e confirmação. Evidência: `capability-registry.ts`.
- [ ] Associar cada ação operável da UI a um `capabilityId`.
- [ ] Fazer UI e API chamarem o mesmo application service/Command handler.
- [ ] Criar allowlist explícita para internals que não podem ser publicados.
- [ ] Gerar relatório automático UI actions × capabilities × endpoints × tests.
- [ ] Falhar CI quando uma capability operável não possuir contrato público ou justificativa válida.

### F0.035 — Contrato público e descoberta [FR-241]

- [ ] Definir `/v1`, convenções JSON, IDs, datas, frames, cursor pagination e filtros.
- [ ] Criar source of truth para OpenAPI, JSON Schemas e capability discovery.
- [ ] Implementar error envelope e catálogo de códigos estáveis.
- [ ] Publicar examples validados e documentação por build.
- [ ] Implementar breaking-change detector e headers de depreciação/sunset.
- [ ] Criar contract test para cada operation pública.

### F0.036 — Clients, autenticação e escopos [FR-242]

- [ ] Modelar `ApiClient`, `ServiceAccount`, credential ref, scope grants e environments.
- [ ] Implementar emissão/validação de token conforme ADR-013.
- [ ] Criar secrets exibidos uma vez, armazenados por referência e rotacionáveis.
- [ ] Implementar deny-by-default e matriz `<resource>:<action>` server-side.
- [ ] Vincular client, workspace e delegated user ao audit context.
- [ ] Implementar suspend, revoke e kill switch por client/workspace.
- [ ] Criar security E2E de scope, cross-workspace, expiry, rotation e revocation.

### F0.037 — Operações assíncronas [FR-243]

- [ ] Implementar `PublicOperation` e mapear estados internos sem perder retry/cancelabilidade.
- [ ] Retornar 202+operation ID para ingest, Director, provider, sync, batch, render e export.
- [ ] Criar endpoints de list/read/cancel/retry e filtros por projeto/status/type.
- [ ] Expor fase e progresso real ou estado indeterminado honesto.
- [ ] Expor result/error/custo sem embutir mídia grande ou diagnóstico sensível.
- [ ] Criar resilience tests de restart, stale result, cancel e retry.

### F0.038 — Webhooks e eventos [FR-244]

- [ ] Definir event envelope versionado, IDs únicos e catálogo inicial.
- [ ] Implementar outbox transacional a partir de domain/workflow transitions.
- [ ] Modelar endpoint, subscription, secret, filter e delivery attempt.
- [ ] Implementar challenge, assinatura, timestamp e anti-replay.
- [ ] Implementar at-least-once, backoff, dead-letter e replay controlado.
- [ ] Criar UI/API administrativa de status, attempts e rotação de secret.
- [ ] Criar integration tests de duplicação, timeout, assinatura inválida e replay.

### F0.039 — Idempotência e concorrência externa [FR-245]

- [ ] Implementar ledger por workspace/client/key com request fingerprint.
- [ ] Retornar response/operation original em repetição idêntica.
- [ ] Rejeitar mesma key com payload diferente.
- [ ] Exigir `baseVersionId` ou ETag em mutações concorrentes.
- [ ] Reusar auto-rebase/conflict rules da spec 02 e devolver diff estruturado.
- [ ] Criar property tests de requests simultâneas e timeout após commit.

### F0.040 — Interface para agentes e MCP [FR-246]

- [ ] Definir tool names, descriptions, input/output schemas e structured errors.
- [ ] Filtrar tools/capabilities por client, scope, environment e policy.
- [ ] Exigir preflight/approval em tools caras, amplas ou destrutivas.
- [ ] Implementar adapter MCP sobre cliente da Public API, sem acesso direto ao domínio interno.
- [ ] Expor resources paginados de capabilities, projects, operations e reports autorizados.
- [ ] Delimitar transcript/OCR/media metadata como untrusted data em tool inputs/results.
- [ ] Criar E2E por agente para jornada válida, prompt injection e tool não autorizada.

### F0.041 — Transferência externa de mídia [FR-247]

- [ ] Implementar `begin-upload` com kind, size, MIME e checksum esperado.
- [ ] Gerar signed single/multipart sessions curtas com headers obrigatórios.
- [ ] Implementar resume, parts completion e verification antes do ingest.
- [ ] Gerar download grants curtos por asset/artifact autorizado.
- [ ] Impedir storage path/URI permanente de virar identidade pública.
- [ ] Criar E2E de upload grande, interrupção, checksum incorreto, expiração e download revogado.

### F0.042 — Preflight e lote externo [FR-248]

- [ ] Definir `PreflightResult` com targets, conflicts, invalidations, jobs, custo, quota e warnings.
- [ ] Gerar commit token vinculado a client, workspace, fingerprint, snapshot e expiry.
- [ ] Invalidar token quando versão, input ou custo material mudar.
- [ ] Exigir preflight para batch, final matrix, geração variável e ações destrutivas.
- [ ] Expor resultado/status/retry por item sem resposta monolítica.
- [ ] Criar E2E de dry-run, token expirado, partial retry e budget block.

### F0.043 — Governança da API [FR-249]

- [ ] Criar administração de clients, scopes, secrets, environments e status.
- [ ] Criar administração de webhooks, subscriptions e delivery diagnostics.
- [ ] Implementar rate limits, quotas, concurrency e spend budgets por client/workspace.
- [ ] Criar usage e audit queries paginadas com redaction.
- [ ] Criar sandbox isolado com provider fakes e custos simulados.
- [ ] Implementar anomaly alerts e kill switch operacional.
- [ ] Criar E2E administrativo sem permitir que client autoeleve seus scopes.

---

## 3. Fase 1 — MVP Core: talking head e voiceover

**Gate da fase:** um vídeo ou áudio de 30–120s produz automaticamente um proxy revisável, recebe correções manuais/por annotation e gera finais 9:16 e 16:9 reconstruíveis.

### F1.001 — Dashboard de projetos [FR-002]

- [ ] Criar query agregada de projeto, versão atual, jobs, review issues e outputs.
- [ ] Implementar cards conforme referência visual, com progresso derivado de steps/items reais.
- [ ] Exibir estados vazio, processando, aguardando revisão, falho, concluído e arquivado.
- [ ] Atualizar cards por eventos sem fabricar percentual quando o job não informa progresso.
- [ ] Criar E2E para transições e ação recomendada em cada estado.

### F1.002 — Busca e filtros [FR-003]

- [ ] Definir filtros por texto, status, objetivo, formato, locale, data e owner.
- [ ] Implementar busca paginada, ordenação estável e combinação de filtros.
- [ ] Persistir filtros durante a sessão e refletir estado na URL quando adequado.
- [ ] Testar isolamento de workspace, paginação e zero results.

### F1.003 — Ações rápidas [FR-004]

- [ ] Implementar abrir, revisar, duplicar, renomear, arquivar e restaurar projeto.
- [ ] Aplicar autorização e confirmação conforme impacto de cada ação.
- [ ] Refletir resultado otimista somente quando houver rollback seguro.
- [ ] Criar E2E incluindo duplicação copy-on-write e falha recuperável.

### F1.004 — Objetivo estratégico [FR-010]

- [ ] Modelar descoberta, consciência, aquecimento, leads, venda, WhatsApp, agendamento e download.
- [ ] Criar formulário inicial com descrição e exemplos de resultado de cada objetivo.
- [ ] Associar objetivo à rubrica correta no `DirectorRun`.
- [ ] Impedir troca silenciosa depois da aprovação; gerar nova versão/re-run.
- [ ] Testar uma fixture por objetivo estratégico.

### F1.005 — Rubricas estratégicas [FR-010]

- [ ] Codificar critérios e pesos de descoberta, consciência e aquecimento.
- [ ] Codificar critérios e pesos de leads, venda, WhatsApp, agendamento e download.
- [ ] Versionar rubrica e persistir seus scores/evidências no `QualityReport`.
- [ ] Implementar hard gates comuns para integridade, legibilidade, direitos e CTA quando obrigatório.
- [ ] Criar dataset de referência com exemplos bom/limítrofe/ruim por objetivo.
- [ ] Calibrar thresholds iniciais sem misturar performance comercial com causalidade garantida.

### F1.006 — Ação desejada [FR-011]

- [ ] Modelar ação, destino, CTA verbal/visual, URL/handle e requisitos de disclosure.
- [ ] Validar campos obrigatórios por objetivo sem inventar destino ausente.
- [ ] Disponibilizar CTA estruturado para StoryPlan, subtitle, overlay e critic.
- [ ] Testar mismatch entre objetivo, CTA falado e destino configurado.

### F1.007 — Briefing livre opcional [FR-012]

- [ ] Adicionar briefing opcional sem bloquear avanço quando vazio.
- [ ] Tratar briefing como dado autorizado do owner e manter conteúdo ingerido separado.
- [ ] Exibir resumo estruturado e assumptions antes de geração cara.
- [ ] Criar E2E com briefing completo, parcial e ausente.

### F1.008 — Brief Compiler [FR-013]

- [ ] Definir schema para audience, offer, constraints, must-use, avoid, tone e success criteria.
- [ ] Compilar texto livre em estrutura com evidence spans, confidence e conflitos.
- [ ] Validar resultado contra guardrails e solicitar revisão somente em conflito material.
- [ ] Versionar prompt/model/schema e salvar entrada/saída redigida.
- [ ] Criar golden set de briefings ambíguos, maliciosos e contraditórios.

### F1.009 — Modo media-only [FR-014]

- [ ] Detectar ausência de briefing e iniciar análise somente com objetivo, ação e mídia.
- [ ] Inferir TreatmentPlan com assumptions explícitas e confidence reduzida quando necessário.
- [ ] Bloquear inferências de oferta/claim não sustentadas pelo material.
- [ ] Criar E2E do upload ao proxy sem briefing livre.

### F1.010 — Override por projeto [FR-021]

- [ ] Modelar `inherit`, `none` e `custom` para cada elemento de marca/guardrail permitido.
- [ ] Mostrar valor resolvido e origem no editor.
- [ ] Persistir override no Policy Snapshot da versão.
- [ ] Testar desativação de logo/handles em um projeto sem alterar o workspace.

### F1.011 — Tipos de entrada [FR-030]

- [ ] Criar upload direto para vídeo, áudio e imagem com MIME/extension sniffing.
- [ ] Implementar multipart, progress, cancel e retomada.
- [ ] Fazer probe/quarantine antes de marcar asset como utilizável.
- [ ] Exibir erro acionável para codec, corrupção, tamanho e duração inválidos.
- [ ] Criar E2E para cada tipo e falha de rede.

### F1.012 — Media Library v1 [FR-040]

- [ ] Criar listagem paginada de assets e segments do workspace.
- [ ] Implementar detalhes, thumbnail/waveform, status, origem e rights.
- [ ] Permitir inserir asset elegível no projeto sem duplicar bytes.
- [ ] Implementar filtros mínimos por kind, pessoa, tema e status de direito.
- [ ] Testar navegação, reuso e bloqueio de asset restrito.

### F1.013 — MediaSegment [FR-042]

- [ ] Modelar range semântico, label, description, parent asset e time mapping.
- [ ] Criar segmento sem recortar fisicamente o master.
- [ ] Materializar derivative somente quando um consumer exigir.
- [ ] Testar segmentos sobrepostos, nested e limite exato do asset.

### F1.014 — Image Library v1 [FR-047]

- [ ] Extrair dimensões, orientação, cores, faces/objects e OCR regions.
- [ ] Gerar descrição observada e tags inferidas com provenance/confidence.
- [ ] Criar thumbnail/derivatives sem alterar original.
- [ ] Implementar busca e reutilização em B-roll, insert e card.
- [ ] Criar eval com imagens sem texto, texto pequeno e múltiplos idiomas.

### F1.015 — Catalogação automática [FR-049]

- [ ] Definir quais outputs aprovados viram assets ou segments pesquisáveis.
- [ ] Executar catalogação idempotente após promoção do artifact.
- [ ] Herdar rights/consent e registrar geração/parent no lineage.
- [ ] Evitar indexar temporários, falhas e outputs rejeitados.
- [ ] Testar reprocessamento sem duplicação de catálogo.

### F1.016 — PerceptionTimeline v1 [FR-050]

- [ ] Unificar transcript words, speakers, silence, faces, objects, shots, motion e OCR em tempo canônico.
- [ ] Registrar source/model/version/confidence por observação.
- [ ] Criar API por range para Director, subtitles, reframe e editor.
- [ ] Representar ausência e cobertura parcial sem preencher dados inventados.
- [ ] Criar golden fixtures de talking head, áudio e imagens inseridas.

### F1.017 — EditorialBeat [FR-051]

- [ ] Definir beat semântico independente de linhas de legenda.
- [ ] Derivar boundaries de frase, intenção, pausa, argumento e mudança visual.
- [ ] Permitir ajuste do Diretor sem alterar word alignment original.
- [ ] Testar frases longas, pausas internas e cortes entre subtitle chunks.

### F1.018 — Confidence [FR-052]

- [ ] Padronizar confidence, evidence, reason codes e calibration version.
- [ ] Definir bandas auto-apply, review e block por tipo de decisão.
- [ ] Exibir incerteza relevante no Director panel sem poluir a edição.
- [ ] Medir calibration error no eval set e registrar regressões.

### F1.019 — TreatmentPlan [FR-060]

- [ ] Implementar schema de objetivo, energia, densidade, gramática, pattern breaks, proof e CTA policy.
- [ ] Gerar TreatmentPlan a partir de rubrica, Policy Snapshot e Perception summary.
- [ ] Validar limites determinísticos antes de aceitar plano.
- [ ] Persistir assumptions, alternatives e decisions log.
- [ ] Criar golden plans para os oito objetivos e dois modos de produção.

### F1.020 — Gramática editorial do tratamento [FR-060]

- [ ] Codificar condições de entrada e saída de B-roll por conclusão semântica, obstrução e duração.
- [ ] Definir zoom/pan/tilt simulados com motivo, amplitude, velocidade e cooldown.
- [ ] Implementar curva de energia por ato e densidade adaptativa por objetivo.
- [ ] Aplicar pattern-break budget por janela, tipo e grupo semântico.
- [ ] Validar continuidade de olhar, movimento, posição, cor, áudio e argumento.
- [ ] Criar golden timelines para excesso, escassez e distribuição adequada de estímulos.

### F1.021 — StoryPlan [FR-061]

- [ ] Modelar acts, story blocks, role, intent, dependencies, source candidates e duration target.
- [ ] Permitir cold open referenciar trecho posterior sem duplicar source.
- [ ] Preservar qualifiers, claims, proof context e CTA dependencies.
- [ ] Validar cobertura narrativa e duração antes de compilar EditPlan.
- [ ] Criar golden stories linear, cold-open e voiceover.

### F1.022 — Alternativas de montagem [FR-062]

- [ ] Gerar candidatos variando hook, ordem permitida, assets e pattern breaks.
- [ ] Aplicar hard gates antes de scoring e custo.
- [ ] Comparar candidatos na mesma rubrica e registrar diversidade.
- [ ] Selecionar vencedor e manter alternativas inspecionáveis.
- [ ] Testar empate, baixa confidence e ausência de candidato elegível.

### F1.023 — Segurança narrativa [FR-063]

- [ ] Detectar claims, qualifiers, negação, causalidade, prazos e dependências de prova.
- [ ] Impedir trim/reordenação que altere sentido ou atribuição.
- [ ] Emitir `QualityIssue` localizado com evidência e correção possível.
- [ ] Criar policy fixtures para promessa, testemunho, comparação e contexto removido.

### F1.024 — Ferramentas do Diretor [FR-064]

- [ ] Expor ferramentas tipadas de busca, criação de plano, proposta de asset, avaliação e patch.
- [ ] Validar argumentos, scope, rights, budget e base version em cada chamada.
- [ ] Proibir mutação direta de banco/storage pelo modelo.
- [ ] Criar integration tests com model fake emitindo chamadas válidas e inválidas.

### F1.025 — Decisions log [FR-065]

- [ ] Persistir decisão, candidates, evidência, confidence, score, custo e actor.
- [ ] Vincular decisão a run, plan node, command e artifact resultante.
- [ ] Exibir explicação resumida e detalhe auditável no Director panel.
- [ ] Testar lineage de decisão até o frame final.

### F1.026 — Budget do Diretor [FR-066]

- [ ] Modelar limites de custo, tempo, tokens, gerações, candidates e critic rounds.
- [ ] Estimar consumo antes de operações pagas e reservar budget atomicamente.
- [ ] Encerrar com melhor resultado válido ou estado `budget_exhausted` recuperável.
- [ ] Mostrar estimado versus realizado por run e projeto.
- [ ] Testar concorrência, overrun de provider e cancelamento.

### F1.027 — Talking head [FR-090]

- [ ] Criar template narrativo para pessoa real como fonte principal.
- [ ] Detectar e remover silêncios/retakes preservando naturalidade e contexto.
- [ ] Planejar B-roll, legendas, reframe, movimentos e pattern breaks.
- [ ] Renderizar proxy e final com áudio sincronizado.
- [ ] Criar E2E de 30s, 60s e 120s com golden de timing.

### F1.028 — Visual montage/voiceover [FR-091]

- [ ] Aceitar áudio como narrativa principal sem exigir pessoa visível.
- [ ] Segmentar áudio em beats e gerar AssetBriefs para cobertura visual.
- [ ] Montar imagens, vídeos, cards e movimentos sem telas vazias indevidas.
- [ ] Validar cobertura, repetição, ritmo e legibilidade.
- [ ] Criar E2E de vídeo totalmente sem pessoas.

### F1.029 — Formatos obrigatórios [FR-160]

- [ ] Cadastrar 9:16, 16:9, 4:5, 1:1 e 21:9 como presets versionados.
- [ ] Definir resoluções, safe areas e defaults de export por preset.
- [ ] Permitir customização validada sem alterar o aspect ratio nominal.
- [ ] Criar schema e render smoke para os cinco formatos.

### F1.030 — Responsive placement [FR-163]

- [ ] Implementar anchors, constraints, min/max size, safe areas e collision avoidance.
- [ ] Resolver placement por formato sem coordenada absoluta compartilhada.
- [ ] Gerar warning quando constraints forem impossíveis.
- [ ] Criar visual goldens de legendas, logo, CTA e insert nos cinco canvases.

### F1.031 — Reframe [FR-164]

- [ ] Implementar crop plan baseado em face/object/region of interest por frame/range.
- [ ] Suavizar trajetória respeitando velocidade e margem de segurança.
- [ ] Permitir keyframes/override manual por formato.
- [ ] Emitir issue quando sujeito não couber ou percepção estiver incerta.
- [ ] Criar fixtures de uma pessoa, duas pessoas, tela e objeto móvel.

### F1.032 — Crítica por formato [FR-165]

- [ ] Avaliar clipping, safe area, subject visibility, subtitle collision e densidade por output.
- [ ] Localizar issue em format, frame range e element IDs.
- [ ] Reprovar apenas variante afetada quando o plano canônico estiver válido.
- [ ] Criar visual eval específico para 9:16 e 16:9 no MVP.

### F1.033 — Estilos iniciais de legenda [FR-170]

- [ ] Especificar cinco presets distintos com tokens, animação e limites responsivos.
- [ ] Implementar renderer de cada preset com fonte licenciada/fallback.
- [ ] Expor preview rápido sem render final completo.
- [ ] Criar visual goldens nos formatos MVP e em fundos claros/escuros.

### F1.034 — Modos de legenda [FR-171]

- [ ] Implementar `auto`, `workspace-default`, `manual` e `none`.
- [ ] Resolver modo por projeto/variant sem alterar transcript.
- [ ] Exibir origem do preset e permitir override/revert.
- [ ] Criar E2E para troca de modo e ausência intencional de legendas.

### F1.035 — SubtitleStylePreset [FR-172]

- [ ] Modelar tipografia, line breaking, highlight, background, animation, margins e overrides.
- [ ] Validar contraste, glyph coverage e limites de linhas/caracteres.
- [ ] Versionar presets para reproduzir renders antigos.
- [ ] Criar unit tests do schema e golden render por preset.

### F1.036 — Anchor de legenda por percepção [FR-173]

- [ ] Consultar faces, OCR, CTA, logo e inserts no range da legenda.
- [ ] Selecionar anchor elegível com estabilidade temporal e safe area.
- [ ] Evitar saltos frequentes; emitir issue se não existir região segura.
- [ ] Criar fixtures de rosto inferior, tela cheia e múltiplos overlays.

### F1.037 — Override de legenda por segmento [FR-174]

- [ ] Modelar override de position, style, text e visibility por subtitle segment.
- [ ] Aplicar override somente à variant e range selecionados.
- [ ] Preservar override protegido durante recompilação automática.
- [ ] Testar reset para nível anterior e invalidation mínima.

### F1.038 — Sidecar [FR-175]

- [ ] Exportar SRT e VTT a partir do alignment efetivamente renderizado.
- [ ] Normalizar timestamps, line breaks e encoding UTF-8.
- [ ] Validar monotonicidade e ausência de overlaps inválidos.
- [ ] Criar round-trip fixture com pontuação, acentos e última cue.

### F1.039 — Preview interativo [FR-210]

- [ ] Integrar player ao proxy da ProjectVersion ativa.
- [ ] Implementar play, pause, seek e frame/timecode confiáveis.
- [ ] Exibir resolução/fps/hash do proxy e banner stale.
- [ ] Medir primeiro frame, seek p95 e dropped preview frames.
- [ ] Criar E2E de navegação e troca de versão.

### F1.040 — ReviewAnnotation [FR-211]

- [ ] Modelar frame, time range, screenshot, region, target IDs, texto, author e status.
- [ ] Implementar clique/drag sobre preview com captura do contexto visual.
- [ ] Persistir annotation sem alterar a versão até aplicação explícita.
- [ ] Criar E2E de annotation pontual, regional e de cena.

### F1.041 — Escopos de revisão [FR-212]

- [ ] Implementar frame, region, clip, scene, range, project, formats, locales e recipes.
- [ ] Definir default restrito ao alvo, formato e locale atuais.
- [ ] Exigir confirmação para escopo global e mostrar quantidade afetada.
- [ ] Testar resolução de target e expansão determinística de scope.

### F1.042 — RenderElementMap [FR-213]

- [ ] Fazer renderer emitir bounds, z-index, element/clip/scene/source IDs por frame.
- [ ] Implementar hit-test respeitando transparência e priority.
- [ ] Mostrar chooser quando múltiplos elementos forem elegíveis.
- [ ] Validar map hash contra proxy hash.
- [ ] Criar visual/E2E para overlays sobrepostos e canvas redimensionado.

### F1.043 — Patch automático [FR-214]

- [ ] Interpretar annotation em proposta tipada de PatchSet, nunca mutação livre.
- [ ] Resolver ambiguidades, protected elements, policy e budget antes do commit.
- [ ] Exibir impact preview, custo e ranges invalidados.
- [ ] Aplicar patch em nova versão e comparar resultado.
- [ ] Criar E2E para correção válida, ambígua, proibida e falha de render.

### F1.044 — Batch review [FR-215]

- [ ] Permitir selecionar múltiplas annotations compatíveis.
- [ ] Compilar PatchSet único ou explicar conflitos entre comentários.
- [ ] Aplicar all-or-nothing por default e registrar resultado por annotation.
- [ ] Testar transação, rollback e retry parcial quando explicitamente escolhido.

### F1.045 — Edição manual [FR-216]

- [ ] Implementar seleção, trim, split, move, replace e snapping no timeline view model.
- [ ] Implementar inspector de layout, texto, legenda, cor, movimento e áudio MVP.
- [ ] Gerar Commands com scope e optimistic concurrency para cada gesto.
- [ ] Implementar undo/redo como versões auditáveis.
- [ ] Criar E2E por teclado e mouse dos fluxos principais.

### F1.046 — Compare [FR-217]

- [ ] Implementar before/after por toggle, split ou overlay.
- [ ] Sincronizar playhead quando mappings forem compatíveis.
- [ ] Exibir diff semântico e scores/issues antes/depois.
- [ ] Permitir aceitar, reabrir ou restaurar sem apagar versões.
- [ ] Criar E2E com versões de durações diferentes.

### F1.047 — Proxy first [FR-230]

- [ ] Criar workflow que materializa proxy antes de autorizar final.
- [ ] Definir resolução/codec e ranges reaproveitáveis do proxy.
- [ ] Executar hard validators e critic localizado após render.
- [ ] Bloquear final em issue hard; permitir aprovação consciente de warnings.
- [ ] Medir tempo do upload ao primeiro proxy revisável.

### F1.048 — Final render [FR-231]

- [ ] Exigir ProjectVersion/variants aprovadas e inputs não stale.
- [ ] Criar job idempotente de final com qualidade e codec do OutputSpec.
- [ ] Executar validators pós-render e gerar checksum/manifest.
- [ ] Promover artifact atomicamente e preservar tentativas falhas.
- [ ] Criar E2E de aprovação, render, download e reconstrução.

### F1.049 — AssetBrief e seleção de B-roll

- [ ] Implementar `AssetBrief` com intenção, conteúdo, estilo, duração, entrada/saída e elementos proibidos.
- [ ] Pesquisar biblioteca antes de stock/geração e registrar candidates descartados.
- [ ] Avaliar relevância, continuidade, qualidade, rights e excesso de novidade.
- [ ] Permitir decisão “não usar insert” quando nenhum candidate for adequado.
- [ ] Criar eval de inserts corretos, literais demais, irrelevantes e visualmente conflitantes.

### F1.050 — Ciclo fechado de qualidade

- [ ] Implementar hard validators técnicos, policy e de integridade.
- [ ] Implementar asset critic antes de inserir mídia gerada/reutilizada.
- [ ] Implementar proxy critic por rubrica, formato e range.
- [ ] Compilar issues em patches elegíveis e rerender mínimo.
- [ ] Encerrar por aprovação, convergência, budget, issue não corrigível ou revisão humana.
- [ ] Versionar reports e medir regressão no dataset de referência.

### F1.051 — Gate do MVP Core [AC-001 a AC-015]

- [ ] Executar AC-001: workspace, marca/guardrails opcionais e criação de projeto.
- [ ] Executar AC-002: objetivo obrigatório e briefing livre vazio.
- [ ] Executar AC-003: vídeo/áudio persistido como master e proxy derivado.
- [ ] Executar AC-004: transcript com timestamps e detecção de silêncios/retakes.
- [ ] Executar AC-005: TreatmentPlan, StoryPlan e EditPlan estruturados.
- [ ] Executar AC-006: talking head+B-roll e áudio+B-roll sem pessoas.
- [ ] Executar AC-007: asset gerado avaliado, rejeitado e substituído.
- [ ] Executar AC-008: proxy com hard validation e crítica localizada.
- [ ] Executar AC-009: annotation em região/cena aplicada em nova versão.
- [ ] Executar AC-010: trim, troca de B-roll, texto/legenda/layout e undo.
- [ ] Executar AC-011: duplicação sem copiar masters.
- [ ] Executar AC-012: export 9:16 e 16:9 validados separadamente.
- [ ] Executar AC-013: final reconstruído pelo manifest.
- [ ] Executar AC-014: restart e retry sem projeto preso.
- [ ] Executar AC-015: dashboard fiel aos estados do workflow.
- [ ] Executar AC-016: client/agente externo conclui jornada MVP com paridade de versões, policies, jobs e artifacts.
- [ ] Registrar evidência automática/manual e aprovar gate da fase.

---

## 4. Fase 2 — Lotes, reutilização e formatos

**Gate da fase:** materiais fragmentados geram recipes compatíveis, reuso preserva contexto/direitos e a matriz de variantes × cinco formatos possui preflight e retry por item.

### F2.001 — SpeechSegment [FR-043]

- [ ] Modelar texto exato, normalized text, word alignment, speaker, range e complete-thought score.
- [ ] Extrair frases/reflexões sem criar arquivos físicos por segmento.
- [ ] Catalogar emoção, expressão, roupa, cenário e demais metadados com provenance/confidence.
- [ ] Implementar busca por fala, intenção, pessoa e características visuais.
- [ ] Criar fixtures com frase completa, corte incompleto, interrupção e múltiplos speakers.

### F2.002 — EvidenceSegment [FR-044]

- [ ] Modelar claim, qualifier, subject, attribution, consent, context window e integrity status.
- [ ] Vincular transcript exato, frames e evidências adjacentes necessárias.
- [ ] Impedir uso isolado quando qualifier/contexto for obrigatório.
- [ ] Criar policy tests de testemunho, resultado financeiro, antes/depois e hearsay.

### F2.003 — LongFormMoment [FR-045]

- [ ] Modelar chapter, topic, moment, summary, speakers, ranges e salience.
- [ ] Indexar momentos hierarquicamente sem exigir um único resumo de duas horas.
- [ ] Permitir abrir contexto anterior/posterior a partir do resultado.
- [ ] Testar busca e preview em live/podcast com mudanças de assunto.

### F2.004 — ValidatedSegment [FR-046]

- [ ] Modelar validation source, scope, date, performance evidence e expiry.
- [ ] Separar “hook validado” de “vídeo inteiro validado”.
- [ ] Criar protected envelope para copy, take, timing e opening conforme escopo.
- [ ] Impedir alegação de causalidade além da evidência registrada.
- [ ] Testar uso compatível e incompatível em nova recipe.

### F2.005 — Busca híbrida [FR-048]

- [ ] Implementar filtros estruturados por rights, kind, pessoa, duração, locale e metadados.
- [ ] Implementar full-text para transcript/OCR e vector search por intenção/descrição.
- [ ] Unir candidates, remover duplicatas e reranquear com pesos versionados.
- [ ] Exibir por que cada resultado correspondeu e por que foi bloqueado.
- [ ] Criar retrieval eval com precision/recall/nDCG por tipo de consulta.

### F2.006 — Processamento hierárquico [FR-053]

- [ ] Dividir long-form em chunks com overlap e time mapping preservado.
- [ ] Processar sinais baratos antes de visão/LLM caros.
- [ ] Agregar chunks em moments/chapters sem perder evidence spans.
- [ ] Reprocessar somente tiers invalidados por nova versão de modelo.
- [ ] Medir memória, custo e tempo em fixtures de 30min e 2h.

### F2.007 — ProductionBatch [FR-080]

- [ ] Modelar batch, items, source groups, recipes, variants, budget e status agregado.
- [ ] Manter estado, erro, retry e artifacts independentes por item.
- [ ] Criar UI de criação, acompanhamento e filtro do lote.
- [ ] Calcular progresso a partir de steps/items reais.
- [ ] Testar batch parcialmente concluído, cancelado e retomado.

### F2.008 — Importação e script alignment [FR-081]

- [ ] Importar roteiro com hooks, corpos, provas e CTAs identificáveis.
- [ ] Normalizar blocos sem apagar texto original ou ordem do documento.
- [ ] Alinhar bloco → transcript words → source range com confidence/evidence.
- [ ] Classificar exact, near, partial, missing e extra take.
- [ ] Criar UI de revisão dos alinhamentos incertos.
- [ ] Construir golden set com paráfrase, repetição, erro e gravação fora de ordem.

### F2.009 — Biblioteca de takes [FR-082]

- [ ] Agrupar takes pelo ScriptBlock previsto ou intenção inferida.
- [ ] Separar takes consecutivos dentro do mesmo arquivo por retake boundaries.
- [ ] Avaliar completude, performance, áudio, vídeo e integridade.
- [ ] Marcar primary, alternate, rejected e needs-review sem apagar source.
- [ ] Permitir seleção manual e proteção do take escolhido.

### F2.010 — Compatibility graph [FR-083]

- [ ] Criar nós para hooks, corpos, provas e CTAs elegíveis.
- [ ] Implementar hard incompatibilities de oferta, audiência, claim, persona, locale, CTA e continuidade obrigatória.
- [ ] Calcular soft score de narrativa, tom, energia, duração, visual e experimento.
- [ ] Persistir reason codes e evidence por edge.
- [ ] Criar golden graph com combinações aceitas, bloqueadas e limítrofes.

### F2.011 — VariantRecipe [FR-084]

- [ ] Modelar seleção H+B+proof+CTA, ordem, source segments, assumptions e scores.
- [ ] Compilar recipe em StoryPlan/EditPlan sem duplicar masters.
- [ ] Registrar lineage até cada ScriptBlock e take.
- [ ] Permitir recipe sem proof somente quando objetivo/policy permitirem.
- [ ] Testar recipe completa, curta, sem prova e com cold open.

### F2.012 — Anti-explosão combinatória [FR-085]

- [ ] Calcular espaço teórico e elegível antes de criar jobs.
- [ ] Aplicar hard filters, threshold, dedupe e top-N com diversidade.
- [ ] Definir cobertura mínima de hooks/corpos/CTAs dentro do budget.
- [ ] Exibir preflight de quantidade, custo, tempo e reutilização esperada.
- [ ] Exigir confirmação para expansão acima do default do workspace.
- [ ] Testar que produto cartesiano não é materializado sem controle.

### F2.013 — Edição em lote [FR-086]

- [ ] Implementar seleção explícita de recipes, formatos e targets.
- [ ] Gerar impact preview com protected conflicts, invalidations e custo.
- [ ] Aplicar command transaction por política all-or-nothing/skip failures.
- [ ] Exibir diff amostrado antes do commit e resultado por item depois.
- [ ] Criar E2E de troca de CTA, legenda e Brand Kit em lote.

### F2.014 — Partial retry [FR-087]

- [ ] Reenfileirar somente item/step falho com a mesma idempotency lineage.
- [ ] Preservar items concluídos e artifacts válidos.
- [ ] Recalcular progresso/custo sem cobrar cache hits como nova geração.
- [ ] Testar retry de provider, render e validator em um lote misto.

### F2.015 — Source Deconstruction [FR-120]

- [ ] Detectar conteúdo essencial, hook envelope, corpo/CTA e elementos contaminantes.
- [ ] Produzir `DeconstructionReport` com clean candidate ranges e confidence.
- [ ] Preservar fala/contexto necessário ao recortar material publicado.
- [ ] Permitir comparação source versus range limpo.
- [ ] Criar golden fixtures de Reel com abertura, legenda queimada, CTA e cauda removível.

### F2.016 — Detecção de contaminação [FR-121]

- [ ] Detectar burned captions, logos/watermarks, music, borders e overlays.
- [ ] Localizar contaminação por região e range com confidence.
- [ ] Identificar quando remoção destruiria conteúdo essencial.
- [ ] Expor diagnóstico ao Director e à revisão humana.
- [ ] Criar fixtures de cada contaminação e combinações sobrepostas.

### F2.017 — Limpeza MVP [FR-122]

- [ ] Implementar trim, crop/reframe, cover e reject como estratégias explícitas.
- [ ] Escolher estratégia por qualidade residual, integridade e custo.
- [ ] Gerar derivative e manter source publicado imutável.
- [ ] Reavaliar visual/rights após limpeza.
- [ ] Criar visual goldens de cada estratégia e rejeição correta.

### F2.018 — Validation envelope [FR-124]

- [ ] Representar quais partes validadas podem ser alteradas: copy, take, framing, timing e opening.
- [ ] Proteger automaticamente partes dentro do envelope durante reuso.
- [ ] Solicitar aprovação quando uma composição exigir sair do envelope.
- [ ] Registrar no decisions log se a validação foi preservada ou perdida.
- [ ] Testar reuso de hook com corpo/CTA novos sem material excedente.

### F2.019 — Proof need [FR-130]

- [ ] Fazer StoryPlan declarar tipo, função e momento de prova necessários.
- [ ] Consultar EvidenceSegments compatíveis antes de gerar card genérico.
- [ ] Permitir ausência explícita quando não houver prova adequada.
- [ ] Criar golden stories que pedem depoimento, dado, demonstração e nenhuma prova.

### F2.020 — Integrity gate de prova [FR-131]

- [ ] Comparar claim, produto, pessoa, período, audience e consent da prova com a recipe.
- [ ] Bloquear prova descontextualizada, incompatível ou expirada.
- [ ] Preservar qualifier/attribution nos modos visual e verbal.
- [ ] Emitir issue acionável sem sugerir fabricação de evidência.
- [ ] Criar policy eval com falsos positivos e falsos negativos críticos.

### F2.021 — Modos de prova [FR-132]

- [ ] Implementar cutaway, split-screen e proof card.
- [ ] Definir entrada/saída, duração mínima, identificação e legibilidade por modo.
- [ ] Escolher modo conforme mídia, formato, ritmo e necessidade de contexto.
- [ ] Permitir override manual por segmento/formato.
- [ ] Criar visual goldens nos cinco formatos.

### F2.022 — Long-form indexing [FR-133]

- [ ] Criar workflow background resumível para probe, transcript, diarization, chunks e moments.
- [ ] Publicar resultados parciais pesquisáveis com tier/status explícito.
- [ ] Controlar custo e concorrência por duração/tier.
- [ ] Retomar processamento após restart sem duplicar segments.
- [ ] Testar vídeo de 2h dentro do orçamento de performance definido.

### F2.023 — Contiguous extraction [FR-134]

- [ ] Buscar janelas contínuas por objetivo, tópico e duração-alvo.
- [ ] Expandir boundaries para começo/fim semântico e contexto necessário.
- [ ] Pontuar autocontenção, densidade, integridade, áudio e visual.
- [ ] Compilar melhor janela em StoryPlan/EditPlan sem síntese multi-range.
- [ ] Criar golden de conteúdo de 2min extraído de vídeo de 2h.

### F2.024 — Repositório semântico cross-asset [FR-136]

- [ ] Criar índice unificado de assets, segments, moments, speech e evidence.
- [ ] Restringir consulta por workspace, rights e consent antes do rerank.
- [ ] Permitir ao Diretor pedir intenção, atmosfera, pessoa, fala e visual.
- [ ] Registrar candidates reutilizados e motivos de rejeição.
- [ ] Medir retrieval quality e latência com biblioteca crescente.

### F2.025 — ColorPipeline [FR-180]

- [ ] Implementar ordem technical transform → source/camera match → creative LUT → output transform.
- [ ] Persistir color space, transfer, primaries e transform versions.
- [ ] Impedir dupla aplicação de LUT/transform.
- [ ] Criar visual fixtures SDR de fontes distintas e clipping.

### F2.026 — Workspace LUT Library [FR-181]

- [ ] Implementar upload, parse, validação e preview de `.cube`.
- [ ] Modelar licença, owner, tags, version e status ativo.
- [ ] Permitir default do workspace, seleção por projeto e `none` explícito.
- [ ] Criar UI de comparação e remoção segura sem quebrar versões antigas.
- [ ] Criar E2E com LUT válido, inválido e glyph/nome incomum.

### F2.027 — ColorPlan [FR-182]

- [ ] Modelar transforms globais, por source, por camera e por segment.
- [ ] Resolver precedência e overrides de forma determinística.
- [ ] Compilar plano para renderer e manifest.
- [ ] Testar que override local não altera outros segmentos/formatos.

### F2.028 — Export matrix [FR-235]

- [ ] Modelar recipes × formats × locales como outputs endereçáveis.
- [ ] Fazer preflight de quantidade, direitos, readiness, custo e storage.
- [ ] Reutilizar planos/assets/cache comuns sem misturar artifacts.
- [ ] Renderizar e acompanhar cada célula com retry independente.
- [ ] Exportar arquivos/manifests com naming determinístico.
- [ ] Criar E2E com lote parcial nos cinco formatos.

### F2.029 — Jornadas de reuso e lote

- [ ] Executar roteiro com 6 hooks, 3 corpos e 3 CTAs gravados em três arquivos.
- [ ] Demonstrar separação de takes e recipes compatíveis sem produto cartesiano cego.
- [ ] Executar Reel validado, conservar apenas hook essencial e anexar corpo/CTA novos.
- [ ] Selecionar EvidenceSegment de depoimento e preservar contexto/consentimento.
- [ ] Extrair short contínuo de 2min de uma live de 2h.
- [ ] Produzir outputs 9:16, 16:9, 4:5, 1:1 e 21:9 com crítica individual.
- [ ] Registrar evidências e aprovar gate da fase.

---

## 5. Fase 3 — Synthetic Presenter e transformação generativa

**Gate da fase:** texto ou áudio produz personagem IA+B-roll; blocos brutos aprovados entram na biblioteca e são reutilizados sem regeneração; providers podem ser substituídos pelo registry.

### F3.001 — Synthetic presenter [FR-092]

- [ ] Criar modo de produção com presenter profile, roteiro/áudio e visual plan.
- [ ] Compilar áudio, synthetic blocks, B-roll, legendas e overlays no EditPlan.
- [ ] Permitir vídeo totalmente sem pessoa real, usando somente personagem IA+B-roll.
- [ ] Aplicar consent, disclosure e rights antes de geração/export.
- [ ] Criar E2E com provider fake e provider real em ambiente controlado.

### F3.002 — Modo híbrido [FR-093]

- [ ] Permitir real, sintético, voiceover, prova e B-roll no mesmo StoryPlan.
- [ ] Definir regras de continuidade de identidade, áudio, cenário e disclosure entre blocos.
- [ ] Resolver rights/consent separadamente por source e segment.
- [ ] Criar golden de pessoa real → avatar → prova → CTA.

### F3.003 — Audio-first [FR-100]

- [ ] Aceitar texto para TTS ou áudio pronto como source canônico do bloco.
- [ ] Gerar/persistir word alignment antes de solicitar vídeo sintético.
- [ ] Fazer duração do áudio governar ranges e retries do avatar.
- [ ] Reutilizar áudio aprovado quando somente vídeo/provider mudar.
- [ ] Testar texto, áudio enviado e áudio regenerado.

### F3.004 — Provider adapters [FR-101]

- [ ] Implementar contracts comuns definidos no ADR-007.
- [ ] Criar adapter inicial ElevenLabs para TTS/alignment.
- [ ] Criar adapter inicial HeyGen para avatar/lip-sync.
- [ ] Normalizar erros, states, callbacks, costs e artifacts sem vazar tipos do provider.
- [ ] Executar contract suite contra fake e adapters reais.

### F3.005 — Geração por blocos [FR-102]

- [ ] Dividir roteiro em frases/reflexões completas com boundaries estáveis.
- [ ] Criar job e cache key por bloco, voz, profile, locale e configuração.
- [ ] Concatenar blocos preservando alignment e room tone/continuidade possível.
- [ ] Retentar ou substituir apenas bloco falho.
- [ ] Testar inserção, remoção e reordenação sem regenerar blocos intactos.

### F3.006 — SyntheticPresenterProfile [FR-103]

- [ ] Modelar actor, provider identities, voice profiles, languages, consent e restrictions.
- [ ] Versionar mudanças de aparência, voz, disclosure e expiração.
- [ ] Criar UI de cadastro/ativação/desativação com prova de consentimento.
- [ ] Bloquear geração quando profile estiver expirado ou incompatível.
- [ ] Criar policy tests para clonagem de voz e identidade.

### F3.007 — SyntheticMasterAsset [FR-104]

- [ ] Salvar vídeo bruto, áudio final, alignment, provider config e generation lineage.
- [ ] Catalogar cada frase completa como SpeechSegment reutilizável.
- [ ] Marcar qualidade, identidade, roupa, cenário, emoção e direitos.
- [ ] Manter master sintético independente da composição final.
- [ ] Testar reuso em novo projeto sem nova chamada paga.

### F3.008 — Cache sintético [FR-105]

- [ ] Definir hash canônico de conteúdo, profile, provider capability, locale e settings relevantes.
- [ ] Consultar cache após rights/consent e antes de reservar custo.
- [ ] Invalidar somente por mudança que altere o resultado ou elegibilidade.
- [ ] Registrar cache hit/miss e economia estimada.
- [ ] Testar igualdade semântica, config diferente e artifact expirado/corrompido.

### F3.009 — Crítico sintético [FR-106]

- [ ] Avaliar lip-sync, identidade, pronúncia, artefatos, enquadramento e continuidade.
- [ ] Definir hard gates e thresholds por capability/provider.
- [ ] Localizar issue por bloco/range e escolher retry, fallback ou revisão.
- [ ] Criar eval set com falhas conhecidas e controle de regressão.

### F3.010 — TransformationBrief [FR-110]

- [ ] Modelar intent, source range, preserve list, allowed changes, novelty, safety e fallback ladder.
- [ ] Gerar brief a partir do StoryPlan sem enviar conteúdo irrelevante ao provider.
- [ ] Validar direitos, identidade e elementos que não podem mudar.
- [ ] Persistir brief, candidates e resultado no decisions log.
- [ ] Criar contract examples simples e “gestão de tráfego medieval”.

### F3.011 — Modos de transformação [FR-111]

- [ ] Registrar background replacement, stylization, cutaway, camera motion, relight e object/environment change.
- [ ] Definir inputs, outputs, preserves e riscos de cada modo.
- [ ] Declarar capabilities no registry em vez de `if provider` no domínio.
- [ ] Criar contract fixture e fallback válido para cada modo.

### F3.012 — Provider Registry [FR-112]

- [ ] Persistir provider, capability, health, limits, regions, pricing e credentials reference.
- [ ] Implementar routing por requisitos, policy, custo, qualidade e disponibilidade.
- [ ] Registrar razão da seleção e alternativas descartadas.
- [ ] Criar health check/circuit breaker sem apagar jobs em andamento.
- [ ] Testar troca de provider sem alterar `TransformationBrief`.

### F3.013 — Jobs duráveis API/MCP [FR-113]

- [ ] Criar transport adapters separados para API, webhook/polling e MCP.
- [ ] Normalizar submit/result/cancel/resume em `ProviderJob`.
- [ ] Verificar assinatura, replay e correlação de callbacks.
- [ ] Retomar polling/callback wait após restart.
- [ ] Simular timeout, duplicate callback, rate limit e artifact ausente.

### F3.014 — Novelty budget [FR-114]

- [ ] Modelar custo de novidade por transformação, duração e janela narrativa.
- [ ] Penalizar excesso antes de enviar ao provider.
- [ ] Aplicar cooldown e diversidade de grupos de efeito.
- [ ] Expor consumo no TreatmentPlan/QualityReport.
- [ ] Criar golden de vídeo sóbrio, equilibrado e exagerado.

### F3.015 — Fallback de transformação [FR-115]

- [ ] Implementar ladder v2v → composite/background → cutaway/B-roll → source unchanged.
- [ ] Verificar se cada fallback ainda cumpre a intenção do AssetBrief.
- [ ] Preservar melhor artifact válido e custo já incorrido.
- [ ] Mostrar fallback aplicado e permitir revisão.
- [ ] Testar falha transitória, capability ausente e resultado reprovado.

### F3.016 — Crítico de transformação [FR-116]

- [ ] Avaliar intenção, preserve list, identidade, temporal coherence, artefatos e risco.
- [ ] Comparar source/result por regiões e ranges relevantes.
- [ ] Rejeitar resultado que muda conteúdo protegido mesmo se visualmente bom.
- [ ] Emitir issue e acionar ladder conforme confidence/budget.
- [ ] Criar eval set com transformações aceitáveis e violações sutis.

### F3.017 — Limpeza avançada [FR-123]

- [ ] Integrar separation/inpaint por adapter como opções após limpeza MVP.
- [ ] Definir máscara, preserve regions e quality threshold antes do job.
- [ ] Salvar resultado como derivative e nunca substituir source publicado.
- [ ] Comparar custo/qualidade com crop/cover/reject.
- [ ] Criar visual eval para legenda queimada, logo e fundo complexo.

### F3.018 — Mask a partir da revisão [FR-218]

- [ ] Converter região de annotation em coordenadas normalizadas e tracking range.
- [ ] Permitir refino da máscara antes de operação paga.
- [ ] Vincular mask input ao PatchSet/TransformationBrief.
- [ ] Tratar tracking incerto e mudança de formato explicitamente.
- [ ] Criar E2E de selecionar região, remover/alterar e revisar resultado.

### F3.019 — Gate sintético

- [ ] Produzir áudio via ElevenLabs a partir de texto com alignment utilizável.
- [ ] Produzir avatar via HeyGen a partir de áudio pronto e de áudio gerado.
- [ ] Salvar blocos aprovados em estado bruto e catalogá-los.
- [ ] Reutilizar pelo menos um bloco em outro vídeo com zero regeneração.
- [ ] Transformar uma cena por adapter e demonstrar fallback após reprovação.
- [ ] Trocar fake/provider sem alterar domínio, EditPlan ou renderer.
- [ ] Registrar evidências e aprovar gate da fase.

---

## 6. Fase 4 — Multicâmera, tela, react e long-form avançado

**Gate da fase:** fontes com durações e áudios diferentes são agrupadas, sincronizadas, diagnosticadas e editadas; quando não há evidência suficiente, o sistema exige marker/anchor manual em vez de fingir precisão.

### F4.001 — Editorial synthesis multi-range [FR-135]

- [ ] Selecionar múltiplos ranges de um ou mais long-form moments por objetivo.
- [ ] Construir StoryPlan que explicite pontes, omissões e dependências de contexto.
- [ ] Preservar claims, qualifiers e atribuição através dos cortes.
- [ ] Gerar transições ou narration bridge somente quando sustentadas.
- [ ] Criar golden de conteúdo de 2min sintetizado de vídeo de 2h.

### F4.002 — CaptureSession [FR-140]

- [ ] Modelar sessão, tracks, roles, recorder/device, source assets e event metadata.
- [ ] Permitir adicionar câmera, tela, áudio separado e reference media após ingest.
- [ ] Preservar clocks/timebases originais e coverage de cada track.
- [ ] Criar UI de agrupamento e correção de tracks.
- [ ] Testar fontes com inícios, fins e interrupções distintos.

### F4.003 — Session clock [FR-141]

- [ ] Definir tempo canônico da sessão independente de qualquer arquivo normalizado.
- [ ] Implementar mappings source PTS ↔ session time com precision/confidence.
- [ ] Manter conversão monotônica dentro de cada piece.
- [ ] Criar property tests de round-trip e limites numéricos.

### F4.004 — Estratégias de sincronização [FR-142]

- [ ] Implementar cascade timecode/metadata → marker → audio fingerprint → visual event → manual anchor.
- [ ] Registrar método, signals, score e motivo de descarte das alternativas.
- [ ] Definir thresholds de auto-apply, review e insufficient evidence.
- [ ] Criar fixtures para cada método e nenhum sinal comum.

### F4.005 — TrackCoverage [FR-143]

- [ ] Modelar intervals disponíveis, gaps, recorder splits e confidence por track.
- [ ] Impedir seleção de source fora de coverage.
- [ ] Exibir gaps/ausência na timeline e diagnóstico.
- [ ] Criar property tests com source curto, gap interno e overlap de partes.

### F4.006 — Drift [FR-144]

- [ ] Coletar múltiplos anchors distribuídos na sessão.
- [ ] Ajustar offset/rate com residual e limites de correção.
- [ ] Detectar drift não linear e evitar stretch indevido de fala.
- [ ] Criar numeric fixtures de ppm/rate distintos e validar erro final.

### F4.007 — Piecewise maps [FR-145]

- [ ] Modelar pieces contínuos separados por stop, rewind, seek ou recorder restart.
- [ ] Detectar discontinuities por PTS, fingerprint e anchors.
- [ ] Resolver mapping apenas dentro de pieces com coverage válido.
- [ ] Criar property tests de descontinuidade, overlap e gap.

### F4.008 — Sync com áudio separado [FR-146]

- [ ] Permitir scratch audio ser usado como evidência e descartado do mix final.
- [ ] Alinhar master audio a cada vídeo sem exigir durações iguais.
- [ ] Detectar canal silencioso, mix diferente e sample-rate mismatch.
- [ ] Testar câmera ruim + gravador bom + tela sem áudio útil.

### F4.009 — Capture Protocol [FR-147]

- [ ] Criar requisitos por cenário: professor+tela, podcast, react e multicâmera.
- [ ] Exibir pré-requisitos antes do upload e no diagnóstico quando faltarem.
- [ ] Recomendar clap/marker, scratch audio, clock contínuo e gravação de referência.
- [ ] Salvar protocolo usado na CaptureSession.
- [ ] Criar E2E de aceite do protocolo e aviso de sincronização limitada.

### F4.010 — Apollo Sync Marker [FR-148]

- [ ] Especificar marker audiovisual com flash, chirp e ID/tempo decodificável.
- [ ] Criar tela/arquivo de marker para reprodução e captura.
- [ ] Implementar detectors independentes de áudio e vídeo.
- [ ] Fundir detections, medir precisão e rejeitar falso positivo.
- [ ] Criar fixtures filmadas/gravadas em diferentes dispositivos.

### F4.011 — SyncDiagnostic [FR-149]

- [ ] Modelar método, confidence, residual, drift, coverage, warnings e ações.
- [ ] Criar visualização de waveforms/anchors/maps e preview lado a lado.
- [ ] Permitir adicionar/mover/remover anchor manual e recalcular.
- [ ] Bloquear auto-edit quando confidence/coverage estiver abaixo do mínimo.
- [ ] Criar E2E de diagnóstico aprovado, corrigido e impossível.

### F4.012 — Direção multicâmera [FR-150]

- [ ] Detectar active speaker e momentos de demonstração/tela.
- [ ] Definir angle candidates por coverage, qualidade, contexto e continuidade.
- [ ] Aplicar regras de cutaway, reaction, screen focus e minimum shot duration.
- [ ] Evitar jump cuts/ângulos redundantes e respeitar protected selection.
- [ ] Criar golden de podcast, professor+tela e react.

### F4.013 — Multicam color match [FR-183]

- [ ] Estimar diferenças de white balance, exposure e resposta entre câmeras.
- [ ] Aplicar match antes da creative LUT.
- [ ] Permitir reference camera e override por range.
- [ ] Emitir confidence/issue quando fontes não forem comparáveis.
- [ ] Criar visual eval de duas e três câmeras.

### F4.014 — Crítico de cor [FR-184]

- [ ] Detectar clipping, cast, skin tone fora do alvo e mismatch localizado.
- [ ] Avaliar antes/depois do output transform sem confundir intenção criativa.
- [ ] Propor correção limitada ou revisão humana conforme confidence.
- [ ] Criar visual eval com fontes técnicas e LUTs diferentes.

### F4.015 — React playback map

- [ ] Detectar no vídeo de reação os intervalos em que o conteúdo de referência toca, pausa, volta ou avança.
- [ ] Modelar playback pieces entre reference media e session time.
- [ ] Sincronizar reference video sem presumir duração igual à gravação do react.
- [ ] Permitir anchors manuais quando interface/player não estiver visível.
- [ ] Criar fixture com play, pause, rewind e seek.

### F4.016 — Gate multicâmera/long-form

- [ ] Sincronizar podcast com dois participantes e áudios distintos.
- [ ] Sincronizar professor e captura de tela com durações diferentes.
- [ ] Demonstrar diagnóstico insuficiente e requisito escrito de marker/anchor.
- [ ] Editar react com playback map piecewise.
- [ ] Produzir montagem por active speaker e foco na demonstração.
- [ ] Produzir síntese multi-range preservando contexto.
- [ ] Registrar evidências e aprovar gate da fase.

---

## 7. Fase 5 — Localização e áudio avançado

**Gate da fase:** um projeto aprovado gera variantes PT-BR/EN/ES com áudio, timing, legenda, assets textuais e mix próprios; música/SFX respeitam narrativa, beat, rights e critic audiovisual.

### F5.001 — Music-led montage [FR-094]

- [ ] Aceitar música aprovada como estrutura temporal primária do tratamento.
- [ ] Extrair beat grid, downbeats, seções, energia e confidence.
- [ ] Planejar cuts/eventos no grid sem deformar palavra ou integridade narrativa.
- [ ] Definir exceções e fallbacks para beat incerto ou distante.
- [ ] Criar audiovisual golden com cortes corretos e over-editing reprovado.

### F5.002 — Conteúdo canônico [FR-190]

- [ ] Modelar `ScriptBlock` com source locale, intent, claims, CTA e dependencies.
- [ ] Vincular blocos canônicos aos ranges/alignment aprovados.
- [ ] Proteger texto factual e qualifiers durante adaptação.
- [ ] Criar schema fixtures com PT-BR, números, moeda, datas e nomes próprios.

### F5.003 — LocalizationVariant [FR-191]

- [ ] Modelar locale, script version, audio assets, alignment, plan, formats e status.
- [ ] Implementar state machine draft → translating → audio → visual → review → approved/failed.
- [ ] Criar variant a partir da versão canônica aprovada sem copiar masters.
- [ ] Isolar commands, jobs e approval por locale.
- [ ] Testar EN/ES concorrentes e versão canônica atualizada.

### F5.004 — Timings próprios [FR-192]

- [ ] Gerar alignment novo para cada áudio localizado.
- [ ] Calcular desvio de duração por ScriptBlock e total.
- [ ] Adaptar copy, timeline, B-roll e pausas segundo política; não apenas esticar áudio.
- [ ] Recompilar legendas, clips e events dependentes.
- [ ] Criar property tests de mappings com durações ±15% e acima do threshold.

### F5.005 — Modos de áudio localizado [FR-193]

- [ ] Implementar TTS autorizado, voz local, upload pronto, lip-sync, avatar regenerado e subtitles-only.
- [ ] Resolver modos permitidos por profile, consent, locale e provider capability.
- [ ] Manter áudio original disponível e lineage entre versões.
- [ ] Aplicar disclosure quando política/mercado exigir.
- [ ] Criar integration tests de escolha e fallback entre modos.

### F5.006 — LocaleProfile [FR-194]

- [ ] Modelar locale/region, glossary, do-not-translate, tone, CTA conventions, number/date/currency e legal text.
- [ ] Modelar fonts, glyph coverage, line breaking e RTL.
- [ ] Permitir default do workspace e override versionado por projeto.
- [ ] Validar glossary conflicts antes de TTS/render.
- [ ] Criar fixtures PT-BR, EN-US, ES e um locale RTL.

### F5.007 — Assets localizáveis [FR-195]

- [ ] Detectar texto visível por OCR region e classificar importância.
- [ ] Decidir share, replace, localize, regenerate ou reject por asset/region.
- [ ] Gerar derivative localizado preservando background e lineage.
- [ ] Verificar legibilidade, tradução e rights após alteração.
- [ ] Criar eval de card, screenshot, logo, interface e texto irrelevante.

### F5.008 — Crítico de localização [FR-196]

- [ ] Avaliar fidelity, claim/qualifier, glossary, pronunciation, lip-sync, typography e subtitle timing.
- [ ] Definir pesos/hard gates por modo e locale.
- [ ] Localizar issue por ScriptBlock, palavra, frame e asset.
- [ ] Acionar retranslation, TTS retry, timeline reflow ou revisão humana.
- [ ] Criar eval humano+automático para PT-BR → EN/ES.

### F5.009 — Sync modes de áudio [FR-200]

- [ ] Modelar narrative-led, music-led e hybrid no `AudioDirectionPlan`.
- [ ] Definir prioridade, tolerance e comportamento de snap por modo.
- [ ] Persistir escolha/razão no TreatmentPlan e manifest.
- [ ] Criar unit tests de decisão em conflito fala versus beat.

### F5.010 — AudioDirectionPlan [FR-201]

- [ ] Modelar music sections, beat grid, AudioEvents, transitions, ducking e MixPlan.
- [ ] Compilar o plano para timeline e renderer de forma determinística.
- [ ] Permitir overrides por range e protected events.
- [ ] Criar golden plan para narrative-led, hybrid e music-led.

### F5.011 — Sound Library [FR-202]

- [ ] Modelar música, SFX, stinger e room tone com BPM, key, mood, duration e rights.
- [ ] Extrair waveform, loudness, beat grid e sections como metadata versionada.
- [ ] Implementar busca híbrida por função, energia, tema e licença.
- [ ] Bloquear uso fora de território/canal/expiração.
- [ ] Criar E2E de ingest, análise, busca e inserção.

### F5.012 — Sound budget [FR-203]

- [ ] Definir densidade máxima, cooldown, repetition group e intensidade por janela.
- [ ] Aplicar budget a SFX, whoosh, hit, stinger e transições.
- [ ] Penalizar eventos redundantes antes da renderização.
- [ ] Expor consumo e remoções no QualityReport.
- [ ] Criar golden de mix sóbrio, adequado e exagerado.

### F5.013 — Mix e master [FR-204]

- [ ] Implementar gain staging de fala, música, SFX e room tone.
- [ ] Implementar ducking com attack/release e automação por fala/evento.
- [ ] Definir loudness target, true peak e limiter por OutputSpec/destino.
- [ ] Preservar tails e evitar clicks nos cortes/crossfades.
- [ ] Gerar loudness report e audio fixtures antes/depois.

### F5.014 — Crítico audiovisual [FR-205]

- [ ] Detectar masking de fala, drift, clipping, pumping, tails cortadas e beat mismatch.
- [ ] Relacionar issue a track/event/range e sugerir patch específico.
- [ ] Reprovar final em falha hard e permitir warning calibrado.
- [ ] Medir resultado em dataset com fala, música vocal/instrumental e SFX.
- [ ] Criar audiovisual golden e revisão humana amostral.

### F5.015 — Gate localização e áudio

- [ ] Localizar projeto PT-BR aprovado para EN e ES.
- [ ] Demonstrar novo áudio, alignment, timeline, legenda e CTA por locale.
- [ ] Fazer lip-sync/avatar quando consentido e subtitles-only quando não.
- [ ] Localizar ou substituir assets com texto visível.
- [ ] Exportar matriz multi-locale em pelo menos 9:16 e 16:9.
- [ ] Produzir versões narrative-led e hybrid com mix validado.
- [ ] Demonstrar music-led sem deformar fala.
- [ ] Registrar evidências e aprovar gate da fase.

---

## 8. Requisitos não funcionais e plataforma

### NFR.001 — Idempotência [NFR-001]

- [ ] Definir idempotency key por upload, command, workflow step, provider submit e render.
- [ ] Criar unique constraints ou ledger para impedir efeito externo duplicado.
- [ ] Retornar resultado anterior quando a mesma operação já tiver concluído.
- [ ] Testar request duplicada, callback duplicado e retry após timeout sem resposta.
- [ ] Medir violações de idempotência como incidente crítico.

### NFR.002 — Resume [NFR-002]

- [ ] Identificar checkpoints seguros em ingest, perception, Director, provider, render e batch.
- [ ] Persistir checkpoint e artifact parcial antes de confirmar avanço do workflow.
- [ ] Reconciliar jobs `running` sem heartbeat após restart.
- [ ] Criar chaos tests interrompendo cada fase longa.
- [ ] Garantir que operador possa retry/cancel sem editar banco manualmente.

### NFR.003 — Observabilidade [NFR-003]

- [ ] Padronizar logs estruturados com workspace, project, version, run, workflow e provider job IDs.
- [ ] Propagar trace context entre web, queue, workers, providers e renderer.
- [ ] Medir duração, espera, attempts, bytes, tokens, custo estimado/real e status.
- [ ] Redigir prompts, transcripts, URLs e dados pessoais segundo política.
- [ ] Criar dashboards por jornada/fase e alertas de hard invariants.
- [ ] Documentar runbook para job preso, provider degradado e render inconsistente.

### NFR.004 — Reprodutibilidade [NFR-004]

- [ ] Salvar manifest, props, hashes, tool/model versions, seeds e provider config permitida.
- [ ] Distinguir reprodução determinística de reexecução best-effort de provider generativo.
- [ ] Fixar fonts, LUTs, renderer package e assets usados pelo artifact.
- [ ] Criar comando de replay em ambiente isolado.
- [ ] Comparar hashes ou visual/audio tolerances em golden replay.

### NFR.005 — Performance [NFR-005]

- [ ] Definir budgets de shell, metadata, primeiro frame, seek, timeline input e commands.
- [ ] Usar proxy e metadata incremental; nunca baixar master para preview comum.
- [ ] Mover probe, IA, FFmpeg, provider e render para workers.
- [ ] Virtualizar timeline/biblioteca e degradar thumbnails antes de input latency.
- [ ] Criar testes p50/p95 em projeto pequeno, médio, 1.000 clips e long-form.
- [ ] Criar alertas de regressão por build.

### NFR.006 — Escalabilidade [NFR-006]

- [ ] Separar filas e concurrency controls de ingest, perception, Director, provider e render.
- [ ] Definir autoscaling, backpressure, prioridade e quota por workspace.
- [ ] Evitar fan-out sem preflight em batch/export/localization.
- [ ] Criar load tests de uploads, batches e callbacks concorrentes.
- [ ] Definir capacidade e custo por worker class.

### NFR.007 — Segurança [NFR-007]

- [ ] Retirar credenciais de código, prompts, manifests públicos e campos em claro.
- [ ] Implementar secret references de menor privilégio e rotação.
- [ ] Aplicar autorização server-side por workspace em API, storage e jobs.
- [ ] Usar signed URLs curtas, MIME validation, malware/quarantine e SSRF protection.
- [ ] Verificar assinatura/replay de webhook e autenticação de MCP/API.
- [ ] Auditar criação/uso/export de mídia sintética e protected data.
- [ ] Executar threat model e security tests antes de cada gate público.

### NFR.008 — Privacidade [NFR-008]

- [ ] Classificar assets, faces, vozes, consentimentos, testemunhos e transcripts como dados sensíveis adequados.
- [ ] Definir coleta mínima, finalidade, acesso, retenção e compartilhamento.
- [ ] Implementar deleção rastreável com tombstone e tratamento de derivatives/cache.
- [ ] Implementar export de dados e audit trail conforme política aplicável.
- [ ] Impedir conteúdo sensível em analytics/logs não autorizados.
- [ ] Testar deleção de source com projetos, segments e artifacts dependentes.

### NFR.009 — Compatibilidade [NFR-009]

- [ ] Versionar schemas de banco, events, EditPlan, manifests, provider result e embeddings.
- [ ] Implementar migrations forward e política de leitura de versões antigas.
- [ ] Manter golden fixtures das versões suportadas.
- [ ] Rejeitar versão desconhecida com erro acionável, sem coerção silenciosa.
- [ ] Testar upgrade em cópia de dataset representativo.

### NFR.010 — Testabilidade [NFR-010]

- [ ] Manter regras de domínio puras e relógio/IDs/model calls injetáveis.
- [ ] Criar fake adapters para storage, models, providers, workflow e renderer.
- [ ] Organizar fixtures de timing, sync, claims, layout, cor, áudio e localização.
- [ ] Criar golden update reviewado, nunca atualização automática em CI.
- [ ] Executar E2E das nove jornadas do PRD.
- [ ] Publicar cobertura por risco, não apenas percentual de linhas.

### NFR.011 — Paridade e estabilidade externa [NFR-011]

- [ ] Criar contract test público para cada capability operável.
- [ ] Executar parity E2E comparando UI, REST e MCP sobre o mesmo fluxo.
- [ ] Publicar OpenAPI/schema/tool catalog a partir do mesmo source versionado.
- [ ] Detectar breaking changes e exigir depreciação/nova major.
- [ ] Medir clients ativos por versão antes de sunset.
- [ ] Documentar migration guide e manter errors estáveis dentro da major.

---

## 9. Métricas de produto, qualidade e operação

### 9.1 Instrumentação de produto

- [ ] Medir material enviado → primeiro proxy por modo, duração e workspace.
- [ ] Medir projetos aprovados sem alteração manual, com definição explícita de “aprovação”.
- [ ] Medir patches por vídeo, rounds de critic e annotations reabertas.
- [ ] Medir aceitação/rejeição/substituição de B-roll e transformação por origem.
- [ ] Medir reutilização de masters, segments e synthetic blocks versus geração nova.
- [ ] Definir método de estimativa de tempo economizado sem afirmar causalidade indevida.
- [ ] Medir aprovação por formato, locale, objetivo e modo de produção.

### 9.2 Instrumentação de qualidade

- [ ] Medir hard/warning issues técnicos por render e por minuto.
- [ ] Medir erros de legenda por minuto, tipo e idioma.
- [ ] Medir colisões visuais detectadas antes e depois do critic.
- [ ] Medir rejeições por incongruência semântica e integrity gate.
- [ ] Medir falhas de lip-sync, identidade e pronúncia por provider/profile.
- [ ] Medir incidentes de claim/contexto com severidade e escape rate.
- [ ] Criar baseline, alvo e janela de regressão para cada métrica.

### 9.3 Instrumentação operacional

- [ ] Medir sucesso, falha, cancel e tempo em fila por job type.
- [ ] Medir retries, rate limits e circuit breaker por provider.
- [ ] Medir custo por minuto, output, locale, format e recipe.
- [ ] Medir cache hit rate por classe de asset/job.
- [ ] Medir tempo de proxy/final/range render e recursos consumidos.
- [ ] Medir storage master/derivative/temp por workspace e idade.
- [ ] Medir queue depth, oldest job, concurrency e saturation.
- [ ] Criar budget alerts e relatórios de custo antes de habilitar batch em escala.
- [ ] Medir requests, errors e latency da API por version, capability e client.
- [ ] Medir rate-limit, quota, idempotency replay e version conflicts.
- [ ] Medir webhook lag, success, retry, dead-letter e replay.
- [ ] Medir tool/MCP calls, denies, preflight e commit por capability.
- [ ] Separar ações iniciadas por UI, REST, SDK e agente sem alterar a semântica do domínio.

---

## 10. Non-goals como testes negativos

### NG.001 — Não virar clone de NLE [NG-001]

- [ ] Limitar MVP ao vocabulário de tracks, layouts, mídia, texto, cor e áudio definido nas specs.
- [ ] Recusar composição nodal, rotoscopia frame a frame e keyframes arbitrários no backlog MVP.
- [ ] Revisar cada proposta de UI contra o risco de editor monolítico.

### NG.002 — Não prometer sync sem evidência [NG-002]

- [ ] Exibir `insufficient evidence` quando não houver clock, sinal, marker ou anchors.
- [ ] Proibir label “sincronizado” abaixo do threshold de confidence/coverage.
- [ ] Testar fluxo de requisitos escritos e alinhamento manual.

### NG.003 — Não fabricar claims/provas [NG-003]

- [ ] Bloquear números, resultados, depoimentos, urgência e contexto não presentes em fonte autorizada.
- [ ] Executar adversarial eval de reescrita e reordenação.
- [ ] Exigir revisão humana quando a integridade não puder ser determinada.

### NG.004 — Não garantir limpeza perfeita [NG-004]

- [ ] Permitir `reject source` como resultado normal da deconstruction.
- [ ] Mostrar perda prevista quando burned text, música ou compressão não forem recuperáveis.
- [ ] Testar que o sistema não promove limpeza visivelmente degradada.

### NG.005 — Não gerar produto cartesiano [NG-005]

- [ ] Bloquear materialização antes de compatibility, diversity, budget e preflight.
- [ ] Definir limite seguro default por workspace.
- [ ] Testar H×B×CTA×format×locale acima do limite.

### NG.006 — Não tratar provider como garantia [NG-006]

- [ ] Manter critic, retry e fallback em toda capability generativa.
- [ ] Exibir capability/health atuais sem prometer disponibilidade futura.
- [ ] Testar provider removido no meio do workflow.

### NG.007 — Não substituir direitos/consentimentos [NG-007]

- [ ] Exigir rights gate independentemente da recomendação do modelo.
- [ ] Bloquear imagem, voz, música, prova e mídia de terceiros sem autorização suficiente.
- [ ] Testar expiração/revogação após cache e antes do export.

### NG.008 — Não transformar tudo em espetáculo [NG-008]

- [ ] Aplicar budgets de pattern break, novelty, movimento e som.
- [ ] Manter “nenhum efeito” como candidate elegível.
- [ ] Criar quality golden que reprova edição exagerada.

### NG.009 — Não usar transcript como instrução [NG-009]

- [ ] Marcar transcript/OCR/document como untrusted content data.
- [ ] Impedir interpolação direta em system/developer policy sem encoding/isolamento.
- [ ] Criar fixtures de prompt injection falado e escrito na tela.

### NG.010 — Não garantir causalidade de performance [NG-010]

- [ ] Exibir validation source/scope e linguagem histórica, não causal.
- [ ] Separar métrica do vídeo e hipótese sobre elemento no modelo de dados.
- [ ] Revisar labels/explicações com exemplos de interpretação indevida.

### NG.011 — Não manter compatibilidade operacional com v1 [NG-011]

- [ ] Proibir decisões de arquitetura justificadas apenas por preservar route/schema antigo.
- [ ] Criar import/adapters explícitos para dados ou módulos reaproveitados.
- [ ] Remover dependência transitiva da v1 após cada extração validada.

### NG.012 — Não publicar internals como API [NG-012]

- [ ] Expor capabilities/resources estáveis, não tabelas, filas, storage keys, prompts ou payloads crus de provider.
- [ ] Proibir endpoint externo que edite EditPlan/banco sem Command, policy e validation.
- [ ] Criar architecture/security tests contra bypass pela superfície pública.

---

## 11. Riscos e mitigação operacional

### R.001 — Escopo excessivo [R-01]

- [ ] Manter gates F0–F5 e impedir feature flag pública antes do gate anterior.
- [ ] Quebrar cada épico em slice vertical demonstrável.
- [ ] Revisar mensalmente itens fora do critério de saída da fase corrente.

### R.002 — Qualidade subjetiva [R-02]

- [ ] Criar dataset de referência por objetivo/modo/formato.
- [ ] Definir rubricas versionadas e avaliação humana amostral.
- [ ] Medir proxy critic e preferências sem auto-aprender alteração destrutiva.

### R.003 — Explosão de custos [R-03]

- [ ] Implementar preflight, reservation budget, cache, dedupe e top-N antes de batch/generation.
- [ ] Criar hard caps por run/workspace e alertas de anomalia.
- [ ] Testar partial retry sem refazer células concluídas.

### R.004 — Providers instáveis [R-04]

- [ ] Manter contract tests, registry, health, circuit breaker e fallback.
- [ ] Monitorar mudanças de capability/preço/limite por versão.
- [ ] Criar runbook de desativação e migração de provider.

### R.005 — Contexto e claims [R-05]

- [ ] Manter qualifiers/dependencies no StoryPlan e EvidenceSegment.
- [ ] Rodar integrity gates antes e depois de reorder/trim/localization.
- [ ] Auditar incidentes e ampliar adversarial fixtures.

### R.006 — Sync impossível [R-06]

- [ ] Publicar Capture Protocol e Apollo Sync Marker antes de prometer automação.
- [ ] Mostrar diagnostic/confidence e oferecer anchors manuais.
- [ ] Testar explicitamente sessões sem sinal comum.

### R.007 — Biblioteca sem governança [R-07]

- [ ] Aplicar checksum, rights, metadata tiers, workspace scope e lifecycle.
- [ ] Medir duplicação, assets unknown e resultados sem uso.
- [ ] Criar rotinas de revisão, archive e deletion seguras.

### R.008 — UI impossível de manter [R-08]

- [ ] Usar Commands e view models em vez de mutations específicas por componente.
- [ ] Manter editor dividido em primitives/painéis e performance budgets.
- [ ] Recusar features avançadas fora do vocabulário aprovado sem ADR.

### R.009 — Prompt injection por conteúdo [R-09]

- [ ] Separar owner-authored policies de mídia/documentos ingeridos no storage e nos prompts.
- [ ] Fazer Brief Compiler estruturar somente canal autorizado.
- [ ] Executar red-team com fala, legenda, OCR e metadata maliciosos.

### R.010 — Crescimento de storage [R-10]

- [ ] Definir quotas, retention policies e classes master/derivative/temp.
- [ ] Tornar derivatives reconstruíveis elegíveis a expiração controlada.
- [ ] Medir storage por lineage, workspace e idade antes de deleção.
- [ ] Implementar garbage collection somente com reference graph verificado.

### R.011 — Abuso, vazamento e custo por automação [R-11]

- [ ] Aplicar credentials revogáveis, scopes mínimos, quotas, rate limits e budgets antes de abrir a API.
- [ ] Detectar loops/anomalias de requests, mutations, generation spend e downloads.
- [ ] Implementar kill switch por client/workspace e runbook de credencial comprometida.
- [ ] Red-team agents para exfiltração, prompt injection, privilege escalation e geração cara repetida.

---

## 12. Reaproveitamento seletivo da Apollo v1

### 12.1 Caracterização antes de reutilizar

- [ ] Criar inventário de Remotion scenes/primitives e dependências ocultas.
- [ ] Criar golden renders dos estilos de legenda atuais.
- [ ] Criar fixtures dos fluxos FFmpeg normalize/cut/proxy.
- [ ] Caracterizar Whisper/word timings, silence e retake removal.
- [ ] Caracterizar timing frame-first, cold open, beat thumbnails e anchor vision.
- [ ] Caracterizar render watchdog, locks, progress e `propsOnly`.
- [ ] Inventariar serviços de imagem, vídeo e stock para adaptação ao Provider Registry.
- [ ] Registrar incidentes/comportamentos que viram testes de regressão.

### 12.2 Extração por contrato

- [ ] Extrair apenas primitives Remotion que aceitem `RenderInput` v2 sem ler banco/config global.
- [ ] Extrair pipeline FFmpeg atrás de recipes e jobs idempotentes.
- [ ] Extrair transcription/timing atrás de adapter versionado.
- [ ] Extrair componentes de legenda atrás de `SubtitleStylePreset`.
- [ ] Extrair watchdog/progress para workflow base sem status ad hoc.
- [ ] Adaptar provider atual somente após passar contract suite.
- [ ] Remover ou isolar dependência da v1 em cada módulo extraído.

### 12.3 Substituições obrigatórias

- [ ] Substituir Prisma `Project` como single source por domínio/versionamento v2.
- [ ] Substituir `scenesJson/editPlanJson` como estado principal por contracts versionados.
- [ ] Decompor `claude.ts` monolítico em Director, tools, policies e model routing.
- [ ] Decompor analyze route em workflow steps idempotentes.
- [ ] Eliminar `Scene` como contrato universal em favor de Story/Edit/Format plans.
- [ ] Decompor editor page monolítica em view models e commands.
- [ ] Migrar configs JSON de fonte de verdade para dados/schema versionados.
- [ ] Remover coupling direto de providers do domínio.

### 12.4 Gate de reaproveitamento

- [ ] Para cada módulo, anexar teste de caracterização anterior e contract test v2 posterior.
- [ ] Rejeitar reutilização quando extração custar mais ou mantiver acoplamento incompatível.
- [ ] Documentar origem, alterações e owner de manutenção do código reaproveitado.
- [ ] Apagar ponte temporária somente depois que fixtures v2 passarem.

---

## 13. Questões abertas e decisões por fase

### Antes de F1 público

- [ ] Decidir modelo de permissões por membro e registrar em ADR-010/012.
- [ ] Decidir limites de auto-aplicação de correções sem revisão humana.
- [ ] Definir duração e custo-alvo do primeiro proxy por duração de source.
- [ ] Definir política inicial de retenção de masters, derivatives e temporários.
- [ ] Decidir OAuth 2.1, signed service keys ou ambos para clients externos.
- [ ] Definir versionamento, depreciação e janela de suporte da API.
- [ ] Definir garantias de ordenação, retenção e replay de webhooks.
- [ ] Definir rate limits, quotas e limites de custo por client/workspace.
- [ ] Definir tools MCP oficiais e quais exigem preflight ou aprovação humana.

### Antes de F2 público

- [ ] Decidir quantidade padrão e máxima de variações por lote.
- [ ] Definir critério e fontes externas para status “validado” de hooks.
- [ ] Decidir importação direta por URL, termos e regras de plataforma.
- [ ] Definir compartilhamento de biblioteca entre workspaces ou confirmar isolamento estrito.
- [ ] Definir licenciamento e provenance de LUTs e stock.

### Antes de F3 público

- [ ] Selecionar providers iniciais de imagem/vídeo além de HeyGen/ElevenLabs.
- [ ] Definir disclosure padrão de mídia sintética por mercado/canal.

### Antes de F5 público

- [ ] Definir estratégia de licenciamento de música e SFX.
- [ ] Calibrar loudness targets e regras de locale/mercado.

Para cada decisão:

- [ ] Registrar owner, data limite, opções, evidências e impacto.
- [ ] Publicar ADR/decision record e atualizar defaults/configuração versionada.
- [ ] Adicionar teste que fixe a decisão onde ela alterar comportamento.

---

## 14. Jornadas E2E obrigatórias

### J.001 — Vídeo bruto único

- [ ] Criar projeto media-only com objetivo estratégico.
- [ ] Ingerir vídeo bruto, normalizar, transcrever e perceber.
- [ ] Gerar TreatmentPlan, StoryPlan, EditPlan, proxy e QualityReport.
- [ ] Aplicar correção por annotation e exportar final reconstruível.

### J.002 — Hooks, corpos e CTAs

- [ ] Ingerir documento com 6 hooks, 3 corpos e 3 CTAs.
- [ ] Ingerir três vídeos contendo os grupos gravados em sequência.
- [ ] Alinhar takes, gerar compatibility graph e selecionar top-N diverso.
- [ ] Renderizar lote, editar CTA em escopo e retentar item falho.

### J.003 — Material publicado validado

- [ ] Ingerir Reel com validation metadata e direitos.
- [ ] Deconstruir, isolar hook essencial e preservar validation envelope.
- [ ] Combinar hook com corpo/CTA novos sem manter material irrelevante.
- [ ] Demonstrar que o sistema não atribui causalidade indevida.

### J.004 — Depoimento/prova

- [ ] Indexar EvidenceSegments com claim, qualifier, pessoa e consent.
- [ ] StoryPlan solicitar prova compatível e integrity gate aprovar/rejeitar candidates.
- [ ] Renderizar cutaway, split ou card preservando contexto.
- [ ] Testar expiração/revogação antes do export.

### J.005 — Live longa

- [ ] Ingerir vídeo de aproximadamente duas horas e processar hierarquicamente.
- [ ] Pesquisar moments antes da conclusão de todos os tiers quando permitido.
- [ ] Extrair conteúdo contínuo de aproximadamente dois minutos.
- [ ] Produzir síntese multi-range e comparar integridade/custo.

### J.006 — Synthetic presenter

- [ ] Gerar áudio por texto e aceitar áudio pronto.
- [ ] Gerar avatar em blocos, criticar e salvar SyntheticMasterAssets.
- [ ] Reutilizar bloco catalogado em composição com B-roll.
- [ ] Localizar bloco autorizado sem regenerar partes não afetadas.

### J.007 — Multicâmera, tela e react

- [ ] Ingerir tracks com durações e áudios diferentes em CaptureSession.
- [ ] Sincronizar por cascade, corrigir drift e representar gaps.
- [ ] Exigir marker/anchor quando evidência for insuficiente.
- [ ] Dirigir podcast, professor+tela e react com playback map.

### J.008 — Localização

- [ ] Criar EN/ES a partir de versão PT-BR aprovada.
- [ ] Adaptar script/áudio/timing/legenda/assets textuais por locale.
- [ ] Aplicar lipsync/avatar ou subtitles-only conforme consent.
- [ ] Exportar matriz multi-locale com crítica e mix próprios.

### J.009 — Operação externa por agente de IA

- [ ] Criar client/service account com scopes mínimos para a jornada.
- [ ] Descobrir capabilities e schemas por API/MCP.
- [ ] Criar projeto, abrir upload session, enviar mídia e iniciar workflow.
- [ ] Acompanhar operation e receber webhook de proxy/QualityReport.
- [ ] Criar annotation/Command com base version e preflight quando exigido.
- [ ] Aprovar, renderizar, exportar e consultar lineage sem usar a UI.
- [ ] Comparar versões, jobs, policies e artifacts com a mesma jornada pela UI.

---

## 15. Linguagem de domínio e documentação viva

- [ ] Criar package de tipos canônicos para Master, Derivative, MediaSegment e SpeechSegment.
- [ ] Criar tipos canônicos para EvidenceSegment, TreatmentPlan, StoryPlan e EditPlan.
- [ ] Criar tipos canônicos para FormatVariantPlan, LocalizationVariant e VariantRecipe.
- [ ] Criar tipos canônicos para DirectorRun, QualityReport, Provider Adapter e CaptureSession.
- [ ] Criar tipos canônicos para ApiClient, PublicCapability, PublicOperation e PublicEvent.
- [ ] Gerar OpenAPI, JSON Schemas e tool schemas do mesmo catálogo de capabilities.
- [ ] Documentar API Client, Public Operation, Capability Discovery e MCP Adapter.
- [ ] Documentar Apollo Sync Marker, Cold open, Voiceover e Synthetic Presenter nos fluxos em que aparecem.
- [ ] Proibir sinônimos ambíguos em código para `scene`, `asset`, `version`, `variant` e `job` sem qualifier.
- [ ] Gerar documentação de schemas e state machines a partir das fontes versionadas quando possível.
- [ ] Atualizar glossário, specs e matriz quando um conceito ganhar ou mudar significado.

---

## 16. Checklist de release por fase

- [ ] Todas as microtarefas obrigatórias da fase estão concluídas ou explicitamente removidas por decisão aprovada.
- [ ] Todos os FRs da fase possuem evidência do teste indicado na matriz de rastreabilidade.
- [ ] NFRs aplicáveis foram executados com budgets e resultados anexados.
- [ ] Security/privacy review não possui finding crítico aberto.
- [ ] Migração foi testada em snapshot e rollback/recovery foi ensaiado.
- [ ] Dashboards, alertas e runbooks da fase estão ativos.
- [ ] Custos unitários e limites de uso foram medidos.
- [ ] Dataset/goldens não apresentam regressão não aprovada.
- [ ] Documentação de usuário explicita pré-requisitos, limitações e fallbacks.
- [ ] Feature flags, quotas e rollout gradual estão definidos.
- [ ] Parity report confirma UI × API × MCP para as capabilities liberadas.
- [ ] OpenAPI, changelog, migration guide, SDK/tool schemas e webhook catalog foram publicados.
- [ ] Critério de saída da fase foi demonstrado em ambiente semelhante à produção.
- [ ] PRD, specs, matriz e este TODO refletem o comportamento entregue.

---

## 17. Cobertura inicial do PRD

| Grupo | Cobertura neste backlog |
|---|---:|
| Princípios de produto | 11/11 |
| Requisitos funcionais | 159/159 |
| Requisitos não funcionais | 11/11 |
| Critérios de aceite do MVP | 16/16 |
| ADRs previstos | 13/13 |
| Jornadas principais | 9/9 |
| Non-goals | 12/12 |
| Riscos | 11/11 |
| Fases do roadmap | 6/6 |
| Microtarefas/checks abertos | 1.220 |

Esta contagem valida presença e fase, não conclusão. Quando o PRD mudar, atualizar este quadro e executar novamente a comparação de IDs com a matriz de rastreabilidade.

---

## 18. Registro de execução

### Slice F0-001 — Chassi de domínio e API-first

**Status:** concluído em 12 de julho de 2026.

Entregas:

- ADR-001, ADR-006 e ADR-013 registrados;
- boundary modular `src/v2` iniciado;
- `OutputSpec` para os cinco formatos com invariantes de canvas e safe area;
- `ProjectVersion` imutável e snapshot refs;
- `EditCommand` com actor, scope, idempotency key e verificação de base version/hash;
- serialização canônica e hash SHA-256 de versão;
- `PublicCapability` registry com scopes, custo, confirmação e parity validator;
- endpoints `GET /v1/health` e `GET /v1/capabilities`;
- scripts `typecheck` e `test` sem dependências novas.

Evidências:

- `npm run typecheck`: aprovado;
- `npm test`: 11 testes aprovados;
- `npm run build`: aprovado em Next.js 14.2.21;
- smoke HTTP dos dois endpoints: aprovado;
- nenhuma versão fixa da v1 foi alterada.
