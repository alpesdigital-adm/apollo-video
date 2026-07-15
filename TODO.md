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
- [x] Definir Prisma Migrate como ferramenta e versionar a migration inicial Postgres. Evidência: `prisma/v2/migrations` e `db:v2:validate`.
- [x] Definir política de rollback/restore e expand-contract. Evidência: ADR-002.
- [x] Ensaiar migration inicial em Postgres 16 dedicado e vazio antes do primeiro ambiente compartilhado. Evidência: `migrate deploy` + integration tests do slice F0-003.
- [x] Implementar isolamento estrutural por workspace, índices e FKs compostas. Evidência: schema/migration v2.
- [ ] Definir retention policy das tabelas e registros operacionais.
- [ ] Definir pgvector, índices e versionamento de embeddings no schema Postgres.
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
- [x] Modelar direitos, consentimento, finalidade, território e expiração. Evidência: F0-021 entrega `asset-rights/v1`, snapshots imutáveis, consent scope, use/market/locale/synthetic operations e validade temporal.
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

- [x] Decidir mecanismo inicial e definir rotação/revogação. Evidência: ADR-010/013 escolhem credentials opacas de service account, múltiplas credenciais e OAuth 2.1 futuro.
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

- [x] Modelar owner, license, permitted uses, territory, expiry, consent e status unknown/restricted. Evidência: `AssetRightsSnapshot` v1 content-addressed e migration F0-021.
- [ ] Criar gate central consultado por busca, Director, geração, render e export. Parcial F0-021: o mesmo evaluator fail-closed já protege a autorização de materialização do RenderInput; faltam busca, Director, geração e export.
- [ ] Bloquear uso quando direitos forem ausentes ou incompatíveis; permitir revisão autorizada. Parcial F0-021: materialização automática é negada para rights/consent ausentes, unknown, restricted, expired, revoked ou fora de use/market/locale/operação; fluxo administrativo de revisão ainda falta.
- [ ] Registrar cada decisão de uso e testar expiração durante projeto ativo. Parcial F0-021: cada autorização persiste decisão por asset, snapshot usado, motivos, actor e validade curta; falta propagação/revogação em projetos ativos.

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
- [x] Persistir base artifact → manifest → sources com FKs compostas por workspace e replay concorrente. Evidência: migration `media_artifacts` e integração Postgres.
- [x] Persistir hashes e versões de tool/model em cada edge. Evidência: manifest v2, colunas normalizadas de execution provenance e API pública por manifest.
- [x] Criar endpoint de inspeção e incluir resumo no manifest. Evidência: `GET /v1/artifacts/{artifactId}`, schema `artifact-detail/v1` e teste público workspace-scoped.
- [ ] Testar reconstrução e diagnóstico de artifact final. Parcial F0-026: grafo, provenance, recipe e RenderInput protegidos, autorização, materialização, render real, recuperação do output comprometido e checkpoint conferido contra artifact/manifest foram entregues; faltam jornada real inteiramente a partir da fixture persistida e comparação golden tolerante.

### F0.026 — Durable jobs [FR-232]

- [ ] Implementar job state machine, heartbeat, attempt e idempotency key. Parcial F0-025: `artifact-render` possui state machine, enqueue idempotente, claim/lease, heartbeat, attempt como fencing token e conclusão CAS; falta generalizar para os demais jobs.
- [ ] Persistir checkpoints antes e depois de efeitos externos. Parcial F0-026: render persiste fase antes do commit e checkpoint tipado depois, com hash/tamanho/probe/target; faltam checkpoints equivalentes nos demais jobs.
- [ ] Implementar retry exponencial, cancelamento e dead-letter. Parcial F0-031: backoff, cancelamento, checkpoint de esgotamento, retry manual e descoberta externa de dead-letter foram entregues para render; métricas/administração agregada e generalização continuam abertas.
- [ ] Simular restart entre cada checkpoint e verificar retomada segura. Parcial F0-026: regressões cobrem perda antes do commit, queda depois do commit e antes do checkpoint, replay de checkpoint, reclaim e output já existente sem nova codificação; faltam checkpoints dos demais jobs.

### F0.027 — Partial invalidation [FR-233]

- [ ] Mapear cada command aos ranges, variants e artifacts afetados.
- [ ] Marcar somente dependentes como stale.
- [ ] Enfileirar proxy/range render mínimo e manter outputs válidos.
- [ ] Testar alteração de legenda, crop, B-roll e source transcript.

### F0.028 — Props e manifest [FR-234]

- [x] Definir `RenderInput` autocontido e schema versionado. Evidência: `render-input/v1`, hash canônico, preflight público e testes de materialização sem banco.
- [ ] Materializar URLs/paths, fonts, LUTs e assets antes de iniciar render. Parcial F0-023: worker relê autorização/payload/rights, adapter local resolve vídeo/áudio/imagem sob raiz privada, verifica bytes por streaming e entrega somente a lease ao renderer real; faltam storage S3-compatible/signed URLs, fonts, LUTs e data.
- [x] Definir manifest portátil base para artifacts com checksum, canonical key, recipe e sources. Evidência: `media-artifact-manifest/v1` e integração local.
- [x] Salvar manifest com checksums, plan hash e renderer version. Evidência: `media-artifact-manifest/v4` vincula por hash um `render-input/v1` protegido que contém checksums ordenados, plan hash e identidade versionada do renderer.
- [ ] Reexecutar golden render somente a partir do manifest salvo. Parcial F0-026: output real pode ser recuperado pela identidade determinística e o checkpoint só é aceito quando corresponde ao artifact/manifest persistido; falta unir fixture Postgres e Remotion real no mesmo teste golden tolerante.

### F0.029 — Estados visíveis [FR-236]

- [ ] Definir estados válidos de projeto, versão, job, item batch e artifact.
- [ ] Implementar transições server-side e rejeitar saltos inválidos.
- [ ] Mapear estado técnico para label, progresso e ação na UI.
- [ ] Testar sucesso, espera, retry, cancel, falha parcial, stale e conclusão. Parcial F0-028: sucesso, retry, cancelamento de queued/retrying/running, stale worker, checkpoint tardio e conclusão terminal estão cobertos; waiting e falha parcial genérica permanecem abertos.

### F0.030 — Infraestrutura e smoke vertical

- [x] Provisionar Postgres dedicado em desenvolvimento isolado. Evidência: Postgres 16 com volume próprio, porta restrita ao loopback e migration v2 aplicada.
- [ ] Provisionar object storage em desenvolvimento isolado.
- [ ] Provisionar workflow durável em desenvolvimento isolado.
- [ ] Criar seeds mínimos para workspace, projeto, source e OutputSpec.
- [x] Configurar audit, typecheck, unit, migration check, contract gate, build e integrações Postgres/API no CI. Evidência: `.github/workflows/ci.yml`.
- [ ] Configurar lint no CI após selecionar regras e corrigir o baseline da v1.
- [ ] Configurar golden tests no CI após existir fixture/render determinístico. Parcial F0-023: smoke render real e sem golden hash foi incluído no CI; faltam fixture persistida e tolerâncias visual/áudio cross-platform.
- [ ] Configurar E2E no CI após existir jornada vertical F0 executável.
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
- [x] Atualizar Next.js/React para uma linha suportada sem quebrar App Router, Remotion ou os contratos `/v1`. Evidência: Next 16.2.10, React 19.2.7, codemod async params e validação completa.
- [x] Corrigir advisories não-major de `uuid`, `postcss` e `form-data`. Evidência: versões corrigidas/override PostCSS e `npm audit` com zero vulnerabilidades.
- [ ] Configurar S3-compatible storage.
- [x] Impedir SQLite como domínio final fora de protótipos locais. Evidência: `resolveV2PersistenceMode` exige Postgres em produção e não possui fallback silencioso.
- [ ] Gerar diagrama/schema documentation e testar integridade referencial dos aggregates centrais.

### F0.034 — Paridade API-first [FR-240]

- [x] Criar `PublicCapability` registry com exposure, scopes, schema, custo e confirmação. Evidência: `capability-registry.ts`.
- [ ] Associar cada ação operável da UI a um `capabilityId`.
- [ ] Fazer UI e API chamarem o mesmo application service/Command handler.
- [ ] Criar allowlist explícita para internals que não podem ser publicados.
- [ ] Gerar relatório automático UI actions × capabilities × endpoints × tests.
- [ ] Falhar CI quando uma capability operável não possuir contrato público ou justificativa válida.

### F0.035 — Contrato público e descoberta [FR-241]

- [ ] Definir `/v1`, convenções JSON, IDs, datas, frames, cursor pagination e filtros. Parcial F0-030: `GET /v1/operations` formaliza cursor opaco estável, `limit/after/nextCursor`, ordenação total e allowlist de filtros; convenções transversais dos demais recursos continuam abertas.
- [x] Criar source of truth para OpenAPI, JSON Schemas e capability discovery. Evidência: `schema-registry.ts`, `openapi.ts`, endpoints `/v1/openapi.json` e `/v1/schemas/{id}/{version}`.
- [x] Implementar error envelope e catálogo de códigos estáveis. Evidência: `public-api/errors.ts` e testes HTTP.
- [x] Publicar examples validados e documentação por build. Evidência: 16 examples validados por Ajv Draft 2020-12 e publicados nos schemas/OpenAPI.
- [x] Implementar breaking-change detector contra baseline versionado. Evidência: `contract-snapshot.ts` e `contracts/v1/public-contract-baseline.json`.
- [ ] Implementar headers de depreciação/sunset e migration guide associado.
- [x] Criar contract test para cada operation pública. Evidência: `public-project-api.integration.mjs`.

### F0.036 — Clients, autenticação e escopos [FR-242]

- [ ] Modelar `ApiClient`, `ServiceAccount`, credential ref, scope grants e environments.
- [x] Implementar emissão/validação de token conforme ADR-013. Evidência: service-account token com `scrypt` e comparação constante.
- [x] Criar secrets exibidos uma vez, armazenados por referência e rotacionáveis. Evidência: `ApiCredential`, token one-shot, hashes `scrypt` e endpoints de rotação/revogação.
- [x] Implementar deny-by-default e matriz `<resource>:<action>` server-side. Evidência: `authenticate-api-client.ts` e scopes dos endpoints.
- [ ] Vincular client, workspace e delegated user ao audit context.
- [ ] Implementar suspend, revoke e kill switch por client/workspace.
- [x] Criar security E2E de scope, cross-workspace, expiry, rotation e revocation. Evidência: `public-project-api.integration.mjs` cobre capability filtering, 403/404, overlap zero, token antigo e revogado.

### F0.037 — Operações assíncronas [FR-243]

- [ ] Implementar `PublicOperation` e mapear estados internos sem perder retry/cancelabilidade. Parcial F0-029: contrato, persistência, lease/fencing, fases, backoff, cancelamento e retry manual públicos foram entregues para render; generalização aos demais jobs continua aberta.
- [ ] Retornar 202+operation ID para ingest, Director, provider, sync, batch, render e export. Parcial F0-024: render autorizado retorna 202 com operation ID; os demais tipos continuam abertos.
- [ ] Criar endpoints de list/read/cancel/retry e filtros por projeto/status/type. Parcial F0-030: list/read/cancel/retry e filtros por status/type foram entregues, junto de `targetId`; `projectId` depende de vínculo canônico operação-projeto e continua aberto.
- [ ] Expor fase e progresso real ou estado indeterminado honesto. Parcial F0-025: worker persiste `materializing`, `rendering`, `persisting` e terminal; progresso permanece honestamente 0/1, faltando medição granular e uso separado de `verifying`.
- [ ] Expor result/error/custo sem embutir mídia grande ou diagnóstico sensível. Parcial F0-026: sucesso exige checkpoint durável do output e expõe somente artifact/manifest; storage key, receipt técnico e diagnóstico permanecem internos; custo continua aberto.
- [ ] Criar resilience tests de restart, stale result, cancel e retry. Parcial F0-028: restart/reclaim, stale attempt, disputa de claim, perda de lease, queda pós-commit, retry limitado e cancelamento concorrente estão cobertos; matriz dos demais job types continua aberta.

### F0.038 — Webhooks e eventos [FR-244]

- [x] Definir event envelope versionado, IDs únicos e catálogo inicial. Evidência F0-032: `PublicEvent`, UUID v4, catálogo de 14 tipos, schemas e `GET /v1/events/catalog`; unicidade global durável será fechada pelo outbox.
- [ ] Implementar outbox transacional a partir de domain/workflow transitions. Parcial F0-033: `project.created` e `project.version.created` são persistidos atomicamente com a criação idempotente; demais transitions continuam abertas.
- [x] Modelar endpoint, subscription, secret, filter e delivery attempt. Evidência F0-034: domínios canônicos, registro transacional, cinco tabelas, constraints e regressões de segurança.
- [x] Implementar challenge, assinatura, timestamp e anti-replay. Evidência F0-035/F0-036: challenge durável one-shot, HMAC dos bytes exatos, janela de timestamp, receipt anti-replay e transporte HTTPS pinado com resolução DNS fail-closed.
- [ ] Implementar at-least-once, backoff, dead-letter e replay controlado. Parcial F0-031/F0-045: render possui lease/fencing, backoff, checkpoint, dead-letter e retry manual; webhooks possuem fan-out, claim/lease, dispatch assinado, transporte DNS-pinado, heartbeat, discovery/sharding, secret provider configurado, entrypoint operacional, backoff, dead-letter e replay individual ou por evento exato, ambos idempotentes. Coordenação de rebalanceamento e replay por intervalo continuam abertos.
- [ ] Criar UI/API administrativa de status, attempts e rotação de secret. Parcial F0-042/F0-044: API externa lista/lê diagnostics e executa replay controlado individual ou por evento exato; UI, endpoints/subscriptions e rotação de secret continuam abertos.
- [x] Criar integration tests de duplicação, timeout, assinatura inválida e replay. Evidência F0-035/F0-043: assinatura adulterada, anti-replay durável, deadline absoluto, DNS/rebinding, claim concorrente, lease/fencing, retry/dead-letter e replay administrativo idempotente estão cobertos em contratos, Prisma e HTTP.

### F0.039 — Idempotência e concorrência externa [FR-245]

- [x] Implementar ledger por workspace/client/key com request fingerprint. Evidência: `V2IdempotencyRecord` e repository Prisma.
- [x] Retornar response/operation original em repetição idêntica. Evidência: testes unitário, Prisma e HTTP.
- [x] Rejeitar mesma key com payload diferente. Evidência: `IDEMPOTENCY_PAYLOAD_MISMATCH` testado.
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
- [ ] Impedir storage path/URI permanente de virar identidade pública. Parcial F0-022: lease interna serializa apenas receipt seguro e paths/URLs vivem somente no `MaterializedRenderInput` em memória; faltam download grants e enforcement nos adapters futuros.
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
- [ ] Criar administração de webhooks, subscriptions e delivery diagnostics. Parcial F0-042/F0-044: capabilities `apollo.webhooks.deliveries.list/read/replay` e `apollo.webhooks.events.replay` entregam diagnóstico e replay workspace-scoped; administração de endpoints/subscriptions, rotação e UI continuam abertas.
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
- [x] Garantir que operador possa retry/cancel sem editar banco manualmente. Evidência F0-028/F0-029: capabilities e endpoints externos com scopes separados, persistência transacional e regressões HTTP/PostgreSQL.

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
- [x] Criar fixtures dos fluxos FFmpeg normalize/cut/proxy. Evidência: `tests/media/ffmpeg-service.integration.mjs` cobre também probe, áudio, silêncio e thumbnail.
- [ ] Caracterizar Whisper/word timings, silence e retake removal.
- [ ] Caracterizar timing frame-first, cold open, beat thumbnails e anchor vision.
- [ ] Caracterizar render watchdog, locks, progress e `propsOnly`.
- [ ] Inventariar serviços de imagem, vídeo e stock para adaptação ao Provider Registry.
- [ ] Registrar incidentes/comportamentos que viram testes de regressão.

### 12.2 Extração por contrato

- [ ] Extrair apenas primitives Remotion que aceitem `RenderInput` v2 sem ler banco/config global.
- [ ] Extrair pipeline FFmpeg atrás de recipes e jobs idempotentes.
- [x] Endurecer executor FFmpeg/ffprobe legado com timeout, cancelamento, limite de saída e erros tipados. Evidência: `MediaProcessError` e `tests/media/ffmpeg-service.integration.mjs`.
- [x] Impedir promoção de outputs FFmpeg parciais e preservar o derivado anterior em falha/cancelamento. Evidência: staging irmão, validação, rename e testes de rollback local.
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
- [x] Criar tipos canônicos para ApiClient, PublicCapability, PublicOperation e PublicEvent. Evidência: domínios versionados e registries entregues até F0-032.
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
| Microtarefas/checks abertos | 1.204 |

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

### Slice F0-002 — Persistência e criação externa de projetos

**Status:** concluído em 12 de julho de 2026.

Entregas:

- ADR-002 registrado: Postgres como alvo e SQLite limitado ao protótipo local;
- aggregates `Workspace`, `Project`, `ProjectSnapshot`, `ProjectVersion` e `ApiClient`;
- tabelas Prisma v2 isoladas para workspace, projeto, snapshots, versões, clients e idempotência;
- repository ports independentes de Prisma;
- criação atômica de projeto, dois snapshots e versão inicial;
- replay idempotente sem duplicar projeto, versão ou snapshots;
- service-account token opaco, secret aleatório, hash `scrypt` e comparação constante;
- autenticação por environment, status e scopes `projects:read`/`projects:write`;
- `GET /v1/projects` e `POST /v1/projects`;
- capability discovery autenticada e filtrada por escopos;
- error envelope público sem vazamento de detalhes internos.

Evidências:

- Prisma schema format/validate/generate/db push: aprovados;
- `npm run typecheck`: aprovado;
- `npm test`: 19 testes aprovados;
- integração Prisma transacional e idempotente: aprovada;
- `npm run build`: aprovado;
- integração HTTP autenticada: 401 sem token, 201 na criação, 200 no replay e listagem isolada aprovada;
- registros de integração removidos ao final dos testes.

Pendências deliberadas:

- administração de workspaces/clients e rotação de secret;
- OpenAPI/JSON Schemas gerados;
- cursor pagination, rate limits, audit log e webhooks.

### Slice F0-003 — Chassi Postgres e migrations

**Status:** concluído em 12 de julho de 2026.

Entregas:

- schema Postgres independente em `prisma/v2/schema.prisma`;
- client Prisma v2 gerado separadamente em `generated/prisma-v2`, fora de `node_modules` para sobreviver a reinstalações;
- migration inicial versionada, com FKs compostas que impedem cruzamento de workspace;
- checks SQL para status, ambientes, JSON, sequências e hashes SHA-256;
- scripts de geração, validação e `migrate deploy`;
- verificador que compara migration commitada com o SQL produzido pelo Prisma;
- política de rollback/restore e expand-contract no ADR-002;
- configuração local/produção documentada;
- guard que impede API de produção usar SQLite silenciosamente;
- Postgres 16 dedicado na VPS, com banco, role e volume exclusivos do Apollo;
- porta publicada somente no loopback da VPS e acesso de desenvolvimento por túnel SSH;
- repositories selecionados por factory, usando Postgres em produção e mantendo SQLite apenas como protótipo explícito.

Evidências:

- schema Prisma Postgres formatado e validado;
- migration check: 6 tabelas, 12 índices e 10 chaves estrangeiras;
- migration inicial aplicada com sucesso no banco dedicado vazio;
- inspeção do schema real: 6 tabelas de domínio, 18 índices físicos e 33 constraints;
- 22 testes unitários aprovados;
- integração Prisma transacional/idempotente aprovada contra Postgres real;
- build Next.js aprovado;
- integração HTTP em modo de produção aprovada contra Postgres real: 401 sem token, 201 na criação, 200 no replay e listagem isolada por workspace.

Pendências deliberadas para slices posteriores:

- automatizar backup e teste de restauração antes de persistir dados insubstituíveis;
- integrar migration check e testes Postgres ao CI;
- decidir pgvector e a política de retenção operacional;
- provisionar object storage e workflow durável.

### Slice F0-004 — Administração e rotação de credenciais externas

**Status:** concluído e publicado em 12 de julho de 2026 no commit `cb59a19`.

Entregas:

- ADR-010 fecha credential opaca de service account como baseline e OAuth 2.1 como extensão futura;
- `ApiClient` separado de múltiplas `ApiCredential`, sem bearer secret recuperável;
- migration expand-contract cria `api_credentials`, backfill dos hashes legados e FKs compostas de workspace;
- tokens novos identificam client e credential; parser mantém compatibilidade com o formato legado;
- autenticação verifica client, workspace, environment, credential status, expiry e hash antes de resolver resources;
- criação administrativa idempotente de clients com concessão limitada aos scopes do próprio administrador;
- rotação idempotente com overlap explícito de 0 a 86.400 segundos;
- revogação imediata e idempotente de credential, impedindo que a request revogue a própria credencial corrente;
- `GET/POST /v1/workspaces/{workspaceId}/clients`;
- `POST /v1/workspaces/{workspaceId}/clients/{clientId}/credentials`;
- `DELETE /v1/workspaces/{workspaceId}/clients/{clientId}/credentials/{credentialId}`;
- quatro capabilities administrativas publicadas e filtradas por `clients:admin`;
- bootstrap operacional para o primeiro workspace/client administrativo.

Evidências:

- migration aplicada no Postgres dedicado e schema SQLite-prototype sincronizado;
- migration check: 7 tabelas, 17 índices declarados e 11 chaves estrangeiras;
- 25 testes unitários aprovados;
- typecheck e build Next.js aprovados;
- integração Prisma transacional aprovada;
- integração HTTP production aprovada para criação/replay one-shot, capability filtering, bloqueio de autoelevação, cross-workspace 404, rotação, expiry e revogação;
- idempotency responses inspecionadas sem token ou secret persistido.

Pendências deliberadas:

- status/suspend/revoke e kill switch no nível de client/workspace;
- atualização administrativa de scopes com ETag e proteção contra self-mutation;
- audit log persistido, rate limits, quotas e anomaly detection;
- remoção das colunas legadas de hash em migration contract após a janela de compatibilidade;
- OAuth 2.1 quando houver delegação de usuário.

### Slice F0-005 — Contrato público executável

**Status:** concluído e publicado em 12 de julho de 2026 no commit `59ebf56`.

Entregas:

- `PublicCapability` agora declara auth mode, status de sucesso, idempotência, query parameters, request body e media type;
- registry versionado com 14 JSON Schemas Draft 2020-12;
- OpenAPI 3.1 gerado das mesmas capabilities e schemas usados pela API;
- path parameters, query parameters, bearer auth opcional/obrigatório e `Idempotency-Key` derivados do contrato;
- múltiplos status de sucesso documentam criação e replay idempotente;
- `GET /v1/openapi.json` publica o contrato completo;
- `GET /v1/schemas/{schemaId}/{version}` publica cada schema com media type próprio;
- capabilities públicas para descoberta do OpenAPI e dos schemas;
- `api:v1:validate` verifica refs, operações, status e serialização;
- `prebuild` bloqueia o build se capabilities, schemas e OpenAPI divergirem;
- health passou a devolver request ID pelo mesmo header comum da Public API.

Evidências:

- contract verification: 10 capabilities, 14 schemas e 8 paths;
- 29 testes unitários aprovados;
- typecheck e build Next.js aprovados;
- integração HTTP production aprovou OpenAPI, JSON Schema, media type, schema 404 e headers comuns;
- lifecycle de projects, clients e credentials continuou aprovado após a expansão do contrato.

Pendências deliberadas:

- exemplos completos validados contra cada schema;
- cursor pagination e catálogo formal de filtros/sorts;
- detector de breaking changes contra a última versão publicada;
- headers de depreciação/sunset e migration guide;
- geração de SDKs e adapter MCP a partir do contrato.

### Slice F0-006 — Examples e compatibilidade do contrato `/v1`

**Status:** concluído e publicado em 12 de julho de 2026 no commit `93a4197`.

Entregas:

- Ajv 8 Draft 2020-12 e `ajv-formats` fixados para validação real dos contratos;
- 16 examples cobrindo os 14 schemas públicos, incluindo criação e replay sem reexibir secret;
- examples publicados em cada JSON Schema e propagados aos components do OpenAPI;
- baseline versionado de capabilities e schemas estruturais do `/v1`;
- mudanças aditivas são permitidas; remoção/alteração de capability existente ou schema sob o mesmo ref bloqueia o build;
- comando explícito `api:v1:baseline:update` para mudanças aprovadas e revisáveis;
- três testes dedicados ao detector de compatibilidade;
- client Prisma v2 movido de `node_modules` para `generated/prisma-v2`, evitando remoção por reinstalações npm.

Evidências:

- contract gate: 10 capabilities, 14 schemas, 16 examples, 8 paths e baseline intacto;
- 32 testes unitários aprovados;
- typecheck, migration check e build Next.js aprovados;
- integração HTTP production aprovou examples publicados e todo o lifecycle existente;
- instalação de dependência deixou de remover o client Prisma v2.

Risco identificado:

- `npm audit` encontrou quatro grupos de advisories preexistentes: Next.js 14.2.21 concentra o grupo crítico; `form-data`, `postcss` e `uuid` possuem correções menores disponíveis. O app não está em produção, mas o upgrade é gate antes de exposição pública.

Pendências deliberadas:

- upgrade controlado de Next.js/React e correções menores do audit;
- headers `Deprecation`/`Sunset` e migration guide;
- política para mudanças compatíveis dentro da mesma major sem tornar o gate excessivamente conservador;
- geração de SDK e MCP a partir do OpenAPI.

### Slice F0-007 — Upgrade seguro de Next.js e React

**Status:** concluído e publicado em 12 de julho de 2026 no commit `c350181`.

Entregas:

- migração incremental validada de Next 14.2.21 → 15.5.20 → 16.2.10;
- React/React DOM 18.3.1 → 19.2.7 e types React 19 atualizados;
- codemod oficial `next-async-request-api` aplicado em 15 route handlers;
- `params` de pages/routes dinâmicas agora é assíncrono conforme o App Router atual;
- `serverComponentsExternalPackages` migrado para `serverExternalPackages`;
- `outputFileTracingRoot` explícito elimina inferência incorreta causada por lockfile externo;
- dev/build usam `--webpack` explicitamente enquanto Remotion depende dos aliases atuais;
- requisito de runtime registrado como Node.js 20.9+;
- `uuid` atualizado para 11.1.1, PostCSS para 8.5.18 e `form-data` transitivo corrigido;
- override global de PostCSS elimina a cópia vulnerável aninhada pelo Next;
- TypeScript config atualizado para JSX automático e types de rotas do Next 16.

Evidências:

- `npm audit --audit-level=low`: zero vulnerabilidades;
- 32 testes unitários aprovados;
- typecheck e contract compatibility gate aprovados;
- build Next 16.2.10 com Webpack aprovado;
- integração Prisma/Postgres aprovada;
- integração HTTP production aprovou projects, clients, credentials, OpenAPI e schemas;
- smoke do servidor de desenvolvimento: home, health e OpenAPI responderam 200.

Pendências deliberadas:

- migrar os aliases de Remotion para Turbopack antes de remover `--webpack`;
- atualizar TypeScript/Prisma e demais libs somente em slices próprios, com seus testes de migração.

### Slice F0-008 — Gate de qualidade e segurança no CI

**Status:** concluído e publicado em 12 de julho de 2026 no commit `3fb94db`.

Entregas:

- workflow GitHub Actions para pushes em `main` e pull requests;
- permissões mínimas `contents: read` e cancelamento de execuções obsoletas da mesma referência;
- actions oficiais fixadas por commit SHA, com indicação da major usada;
- Node.js 22 e instalação determinística via `npm ci`/`package-lock.json`;
- `npm audit --audit-level=low` como gate bloqueante e comando local `security:audit`;
- typecheck, testes unitários, contratos públicos e migration/schema check;
- Postgres 16 efêmero com health check e migration deploy real;
- build de produção seguido pelas integrações Prisma e API pública;
- documentação do gate e runtime recomendado no README.

Critério de falha:

- qualquer comando retorna status diferente de zero e bloqueia o job;
- nenhuma credencial externa é necessária: banco e credenciais de integração são efêmeros;
- o job possui timeout de 20 minutos e não publica artifacts nem recebe permissão de escrita.

Evidências locais:

- reinstalação limpa com `npm ci` aprovada;
- YAML válido e workflow aprovado pelo `actionlint` 1.7.12;
- `npm audit --audit-level=low`: zero vulnerabilidades;
- 32 testes, typecheck, contratos e migration check aprovados;
- migration deploy real, build Next 16 e integrações Prisma/API aprovados.

Risco identificado:

- `npm ci` alertou que `fluent-ffmpeg@2.1.3` não possuía mais suporte; risco eliminado no F0-009 pela remoção do wrapper e caracterização do adapter direto.

Pendências deliberadas:

- lint depende da seleção de regras e correção do baseline legado;
- golden depende de fixture e render determinísticos;
- E2E depende da primeira jornada vertical completa;
- configurar a proteção da branch no GitHub para exigir o check `quality` é uma ação administrativa após a publicação do workflow.

### Slice F0-009 — Remoção do wrapper FFmpeg sem suporte

**Status:** concluído e publicado em 12 de julho de 2026 no commit `3b35732`.

Entregas:

- `fluent-ffmpeg` e `@types/fluent-ffmpeg` removidos das dependências e do lockfile;
- configuração especial de externalização removida do Next.js;
- processamento preservado pelo adapter direto existente baseado em `execFile` e arrays de argumentos;
- resolução explícita por `FFMPEG_PATH`/`FFPROBE_PATH`, binários empacotados e fallback final ao `PATH` documentada no ADR;
- fixture audiovisual determinística com três segundos, áudio–silêncio–áudio e resolução 320×240;
- integração caracteriza probe, normalize, proxy, extração de áudio, detecção/corte de silêncio e thumbnail;
- integração de mídia adicionada ao gate do GitHub Actions;
- Remotion/CLI/Player/Renderer alinhados em 4.0.489 e React 19.2.7 após o primeiro runner revelar dependências ausentes e vulneráveis;
- lockfile do subprojeto instalado, cacheado, auditado e empacotado separadamente no CI;
- README corrigido: instalação global de FFmpeg não é obrigatória.

Critérios de segurança e compatibilidade:

- nenhum comando passa por shell ou concatena input em command string;
- paths e filtros são argumentos separados de `execFile`;
- o teste usa somente binários locais e arquivos temporários, sem rede ou providers;
- arquivos temporários são removidos mesmo quando a asserção falha.

Evidências locais:

- `npm ci` aprovado sem o aviso de depreciação de `fluent-ffmpeg`;
- `npm audit --audit-level=low`: zero vulnerabilidades;
- `npm audit --prefix remotion --audit-level=low`: zero vulnerabilidades;
- integração FFmpeg aprovada em Windows usando os binários empacotados;
- bundle do Remotion 4.0.489 aprovado com React 19;
- 32 testes, typecheck, contratos, migration check e build Next 16 aprovados;
- integrações Prisma/Postgres e API pública aprovadas;
- nenhum import, pacote ou configuração restante referencia `fluent-ffmpeg`.

Incidente do primeiro runner:

- o run `29213379388` do commit `3fb94db` falhou corretamente no typecheck porque `remotion/node_modules` não existia no runner limpo;
- a investigação revelou oito advisories no lockfile Remotion antigo, incluindo dois high;
- o gate local foi corrigido para instalar e auditar os dois lockfiles antes do typecheck e para empacotar o renderer explicitamente;
- a correção foi confirmada no runner hospedado `29214156774`: todos os 19 passos concluíram com sucesso.

Pendências deliberadas:

- extrair recipes versionadas e execução idempotente pertence ao media worker v2;
- fixar e registrar versões-alvo de FFmpeg/ffprobe em ADR próprio antes do primeiro ambiente de produção.

### Slice F0-010 — Executor seguro para processos de mídia

**Status:** concluído e publicado em 12 de julho de 2026 no commit `a63e1d5`.

Entregas:

- executor único para FFmpeg e ffprobe preservando `execFile` com `shell: false`;
- opções compatíveis e opcionais de `AbortSignal`, timeout e limite de buffer em todas as operações públicas do adapter;
- timeout default de 30 minutos para FFmpeg e 60 segundos para ffprobe, configuráveis por ambiente e limitados a 6 horas;
- limite default de 8 MiB por stream, configurável e limitado a 64 MiB;
- FFmpeg recebe `-nostdin`, `-nostats`, `-hide_banner` e log level mínimo por operação;
- erros tipados `MediaProcessError` com códigos separados para cancelamento, timeout, excesso de saída e falha operacional;
- mensagens estáveis não incluem command line, argumentos ou paths; somente a cauda limitada de stderr fica disponível para diagnóstico interno;
- chamadas existentes permanecem válidas porque o novo argumento de opções é opcional.

Evidências:

- integração real cobre cancelamento antes do spawn e durante encode ativo;
- timeout de ffprobe encerra o processo e retorna `MEDIA_PROCESS_TIMEOUT`;
- excesso de stderr retorna `MEDIA_PROCESS_OUTPUT_LIMIT` sem crescimento irrestrito;
- input inexistente retorna `MEDIA_PROCESS_FAILED` com stderr limitado a quatro mil caracteres;
- fluxo nominal continua cobrindo probe, normalize, proxy, áudio, silêncio/corte e thumbnail;
- teste de mídia passou três vezes consecutivas para reduzir risco de flakiness temporal.

Pendências deliberadas:

- cancelamento persistente entre processos/restarts pertence ao workflow durável e ao estado canônico de job;
- cleanup e lineage de outputs parciais devem ser definidos nas recipes idempotentes do media worker;
- cada recipe terá SLA próprio em vez de depender apenas do teto global;
- o presenter público deverá mapear códigos internos para erros estáveis sem expor stderr.

Confirmação hospedada:

- o run `29214662544` executou com sucesso os 19 passos no Linux, incluindo todos os cenários do executor de mídia.

### Slice F0-011 — Staging e promoção segura de derivados

**Status:** concluído e publicado em 12 de julho de 2026 no commit `a4b6375`, com hotfix de portabilidade `71a49bc`.

Entregas:

- toda operação FFmpeg que escreve arquivo usa staging oculto no mesmo diretório e filesystem do destino;
- o nome parcial preserva a extensão final para manter inferência correta de container/codec;
- outputs precisam existir, ser arquivo e possuir tamanho maior que zero antes da promoção;
- vídeo normalizado, proxy e autocut também passam por ffprobe antes da promoção;
- promoção usa rename local após toda validação, substituindo o derivado anterior somente no commit final;
- normalize, proxy, áudio e thumbnail rejeitam input/output no mesmo path;
- `MediaOutputError` diferencia conflito, output inválido, falha de promoção e falha de cleanup;
- cancelamento observado depois do encode e antes do commit também impede a promoção;
- todas as assinaturas públicas anteriores continuam compatíveis.

Evidências:

- cancelamento durante encode não cria o path final;
- timeout durante normalize não cria o path final;
- falha com input ausente preserva byte a byte o derivado anterior;
- tentativa input=output preserva byte a byte a fonte;
- sucesso substitui um destino existente somente depois de gerar e validar o novo vídeo;
- ao final de todos os cenários, não resta arquivo com marcador `.partial`;
- fluxo nominal de normalize, proxy, áudio, silêncio/corte e thumbnail continua aprovado.

Pendências deliberadas:

- concorrência entre dois jobs para o mesmo output será impedida por idempotency key/lease no workflow durável;
- object storage exigirá multipart staging e promoção por chave/manifest, não rename de filesystem;
- lineage, checksum e registro transacional do artifact serão adicionados no adapter v2;
- política de garbage collection tratará partials órfãos deixados por encerramento abrupto do processo inteiro.

Confirmação hospedada e incidente:

- o primeiro run `29215297396` revelou que FFmpeg no Linux pode tratar `SIGTERM` e retornar código próprio antes de `execFile` marcar `killed`;
- o hotfix substituiu inferência de timeout por timer controlado e `AbortController` combinado com o signal do chamador;
- o run `29215376497` aprovou todos os 19 passos no Linux, incluindo timeout, cancelamento, staging e promoção.

### Slice F0-012 — Checksum e manifest portátil de artifact

**Status:** concluído e publicado em 12 de julho de 2026 no commit `02d735d`.

Entregas:

- canonicalização/hash compartilhados foram movidos para o domínio sem quebrar os imports existentes de versionamento;
- contrato `media-artifact-manifest/v1` independente de filesystem, banco e object storage;
- artifact registra canonical key, SHA-256, byte size, media type e container;
- recipe registra ID, versão e somente o hash canônico dos parâmetros;
- sources registram canonical key, SHA-256 e papel, suportando múltiplas origens;
- probe opcional registra width, height, duration e fps;
- `manifestHash` cobre deterministicamente todo o corpo e detecta adulteração;
- inspector local calcula SHA-256 por streaming, sem carregar vídeos inteiros em memória;
- writer local serializa canonicamente, grava em partial irmão e promove por rename;
- keys absolutas, Windows paths e traversal `..` são rejeitados pelo domínio;
- paths locais, timestamps voláteis e parâmetros brutos não entram no manifest.

Evidências:

- parâmetros com ordem de chaves diferente produzem manifest idêntico;
- alteração de parâmetro muda `parametersHash` e `manifestHash`;
- alteração de um byte do artifact muda SHA-256 e `manifestHash`;
- prompt privado usado como parâmetro não aparece no JSON persistido;
- diretório temporário absoluto não aparece no JSON persistido;
- manifest adulterado é rejeitado antes da escrita;
- manifest escrito atomicamente é relido e equivale ao objeto validado;
- suíte unitária passou de 32 para 34 testes e a integração usa um vídeo real normalizado.

Pendências deliberadas:

- persistir Artifact/Manifest e lineage transacionalmente no Postgres pertence ao próximo slice;
- canonical key final dependerá da decisão de object storage e namespace por workspace;
- timestamps de criação pertencem ao registro persistido/evento, não à identidade determinística;
- manifests compostos de render incluirão plan hash, renderer version, fonts, LUTs e todos os inputs materializados.

Confirmação hospedada:

- o run `29215758113` aprovou os 19 passos no Linux, incluindo os testes de domínio e integração real do manifest.

### Slice F0-013 — Persistência transacional de Artifact/Manifest/Lineage

**Status:** concluído e publicado em 12 de julho de 2026 no commit `362ddf2`.

Entregas:

- três tabelas Postgres específicas: `media_artifacts`, `media_artifact_manifests` e `media_artifact_lineage`;
- schema SQLite de protótipo mantido estruturalmente compatível para os adapters existentes;
- artifacts armazenam canonical key, SHA-256, byte size `BIGINT`, tipo, container, status e workspace;
- manifests append-only armazenam schema, manifest/parameters hash, recipe/version e JSON canônico validado;
- lineage normalizado armazena source artifact, role e ordinal, preservando a ordem do manifest;
- FKs compostas impedem artifact, manifest ou source de atravessar workspace;
- checks SQL validam hashes, tamanhos, tipos, status, schema, JSON, roles, ordinals e keys portáteis;
- repository Prisma grava artifact, manifest e todos os edges na mesma transação;
- canonical key existente com conteúdo/metadata diferente retorna conflito e nunca sobrescreve;
- replay por canonical key + manifest hash retorna os IDs vencedores e verifica JSON/lineage persistidos;
- colisão concorrente `P2002` é convertida em replay seguro ou conflito explícito;
- source ausente ou checksum divergente aborta e reverte inclusive o artifact de saída criado na transação.

Evidências:

- migration real aplicada em Postgres 16 dedicado;
- migration check: 10 tabelas, 28 índices e 17 foreign keys;
- source e derivado com lineage foram persistidos e relidos;
- repetição idempotente não criou rows adicionais;
- duas transações concorrentes resultaram em uma criação e um replay;
- workspace B não conseguiu referenciar source existente apenas no workspace A;
- checksum divergente da source gerou conflito e rollback integral;
- canonical key absoluta foi rejeitada pelo constraint do Postgres;
- teardown confirmou contagens exatas de artifacts, manifests e edges.

Pendências deliberadas:

- ligar artifact a ProjectVersion, Job e ProviderCall expande o grafo F0.025 em slices posteriores;
- a inspeção pública de lineage foi entregue no slice F0-014;
- status `quarantined/deleted` exigirá command auditável, rights check e retention policy;
- canonical key content-addressed final depende do adapter de object storage.

Confirmação hospedada:

- o run `29216338901` aprovou os 20 passos no Linux, incluindo migration, persistência/replay e integridade de lineage.

### Slice F0-014 — Inspeção pública de Artifact/Manifest/Lineage

**Status:** concluído e publicado em 12 de julho de 2026 no commit `a51b39c`.

Entregas:

- capability pública versionada `apollo.artifacts.read@1.0.0` com escopo dedicado `artifacts:read`;
- endpoint autenticado `GET /v1/artifacts/{artifactId}` sem `workspaceId` controlável pelo cliente;
- application service e query port independentes do transporte e do provider de persistência;
- query Prisma filtra simultaneamente por `artifactId` e workspace autenticado;
- artefato inexistente e artefato de outro workspace retornam o mesmo erro público 404;
- resposta expõe somente metadata segura, probe, recipe hashes e sources ordenadas;
- paths físicos, `manifestJson` e parâmetros brutos da recipe não são serializados;
- `BIGINT byteSize` é publicado como string decimal, sem perda de precisão em JSON;
- cada leitura revalida hash/corpo do manifest e confere metadata normalizada, recipe e lineage;
- corrupção ou divergência persistida produz conflito explícito em vez de informação silenciosamente incorreta;
- JSON Schema `artifact-detail/v1`, exemplo executável, OpenAPI e baseline de compatibilidade foram atualizados.

Evidências:

- contratos aprovados com 11 capabilities, 15 schemas, 17 exemplos e 9 paths;
- build Next.js registra a rota dinâmica `/v1/artifacts/[artifactId]`;
- teste ponta a ponta autentica cliente com `artifacts:read` e relê source/derivado persistidos no Postgres;
- cliente sem o escopo recebe 403;
- acesso ao artifact de outro workspace e ID inexistente recebem o mesmo código 404;
- lineage retorna source, checksum, role e ordinal na ordem imutável do manifest;
- resposta confirma ausência de `manifestJson` e parâmetros brutos;
- contrato público aditivo foi incorporado ao baseline para impedir remoção ou mudança silenciosa futura.

Pendências deliberadas:

- listagem, busca e paginação de artifacts serão capabilities separadas para não ampliar este contrato por acidente;
- download exige grants temporários e rights check, portanto não faz parte da inspeção de metadata;
- vínculos com ProjectVersion, Job e ProviderCall continuam no grafo F0.025;
- mudança de status, quarentena, deleção e retenção exigirão commands auditáveis próprios;
- MCP consumirá esta mesma capability quando o adapter de ferramentas for implementado.

Confirmação hospedada:

- o run `29216850414` aprovou os 20 passos no Linux, incluindo contratos, build e inspeção pública workspace-scoped.

### Slice F0-015 — Diagnóstico recursivo de lineage

**Status:** concluído e publicado em 12 de julho de 2026 no commit `4e52327`.

Entregas:

- capability pública `apollo.artifacts.lineage.diagnose@1.0.0` protegida por `artifacts:read`;
- endpoint exige artifact e manifest exatos em `/v1/artifacts/{artifactId}/lineage-diagnostics/{manifestId}`;
- travessia recursiva determinística retorna fontes antes dos derivados;
- cada nó informa artifact, checksum, status, quantidade de manifests e manifest selecionado;
- cada edge informa source, target, checksum esperado, role e ordinal;
- diagnóstico detecta artifact indisponível, manifest ausente, source ausente, checksum divergente e falha de integridade;
- ciclos de lineage são detectados sem recursão infinita;
- limites default de 256 nós e profundidade 32 impedem abuso e marcam resultado truncado;
- um manifest que não pertence ao artifact/workspace retorna 404 sem permitir enumeração;
- corrupção do artifact raiz continua produzindo conflito 409; corrupção de source vira issue segura no diagnóstico;
- JSON Schema, exemplo, OpenAPI e baseline foram ampliados de forma aditiva.

Evidências:

- contratos aprovados com 12 capabilities, 16 schemas, 18 exemplos e 10 paths;
- build registra a rota dinâmica de diagnóstico;
- teste unitário comprova ordem source-first, grafo saudável e seleção do manifest exato;
- testes unitários comprovam fonte em quarentena, manifest inexistente, ciclo e truncamento por limite;
- integração pública comprova autenticação, scope, isolamento entre workspaces e resposta 404;
- integração Postgres comprova grafo saudável e mudança para unhealthy quando uma source é colocada em quarentena;
- o diagnóstico não serializa parâmetros brutos, JSON interno ou paths físicos.

Limite explícito desta slice:

- `healthy=true` significa que o lineage materializado e seus manifests estão íntegros e disponíveis;
- ainda não significa que o artifact pode ser regenerado do zero;
- a reexecução real depende de persistir parâmetros reproduzíveis, versões/hashes de tools/models, RenderInput e adapters de provider;
- por isso a microtarefa final de reconstrução em F0.025 permanece aberta.

Confirmação hospedada:

- o run `29217265757` aprovou os 20 passos no Linux, incluindo o diagnóstico recursivo público.

### Slice F0-016 — Execution provenance versionada por edge

**Status:** concluído e publicado em 13 de julho de 2026 no commit `70f225a`; correção de estabilidade publicada no commit `1a58180`.

Entregas:

- contrato interno aditivo `media-artifact-manifest/v2`, mantendo leitura integral do v1;
- cada source edge v2 exige tool ID, versão e digest SHA-256;
- edges gerados por IA também registram provider, model ID, versão e hash canônico da configuração;
- configuração bruta, prompts, seeds privados e parâmetros do provider não entram no manifest nem na API;
- model config com ordem de chaves diferente produz o mesmo `configHash` e `manifestHash`;
- sete colunas normalizadas de provenance foram adicionadas ao lineage no Postgres e SQLite de protótipo;
- constraints SQL garantem grupos tool/model completos, tokens portáteis e hashes válidos;
- manifests v1 continuam legíveis e seus edges permanecem explicitamente legacy, sem provenance inventada;
- replay compara também toda a execution provenance e rejeita divergência imutável;
- leitura do artifact revalida provenance normalizada contra o manifest v2;
- presenter `artifact-detail/v1` foi fechado explicitamente para não alterar o contrato anterior;
- capability `apollo.artifacts.provenance.read@1.0.0` expõe provenance segura por artifact/manifest;
- endpoint `/v1/artifacts/{artifactId}/provenance/{manifestId}` usa scope `artifacts:read` e isolamento do workspace autenticado;
- resposta informa `complete=false` e `EXECUTION_PROVENANCE_MISSING` para edges legacy.

Evidências:

- migration aplicada no Postgres 16 sem alterar dados antigos;
- integração persiste e relê tool ID/version/digest e model provider/ID/version/config hash;
- JSON persistido e resposta pública não contêm o prompt privado usado na fixture;
- manifest v2 rejeita digest inválido;
- teste unitário comprova determinismo do config hash e compatibilidade de manifests v1;
- integração pública comprova autenticação, scope, OpenAPI e provenance completa;
- contratos aprovados com 13 capabilities, 17 schemas, 19 exemplos e 11 paths;
- build registra a nova rota dinâmica de provenance.

Incidente encontrado e resolvido:

- a primeira integração real revelou que o constraint legado aceitava apenas `media-artifact-manifest/v1`;
- a correção foi feita por migration adicional append-only, sem reescrever a migration já aplicada;
- após a migration de compatibilidade, o teste Postgres v2 passou integralmente.
- o primeiro CI publicado (`29289558347`) revelou que uma fixture de idempotência usava relógio fixo e expirava após 24 horas;
- a fixture passou a usar o relógio corrente, eliminando a bomba-relógio sem alterar a regra de produção;
- o run `29289717455` aprovou os 20 passos no Linux após a correção.

Pendências deliberadas:

- provenance informa identidade/hash, mas ainda não persiste o payload reproduzível dos parâmetros;
- prompts e configurações sensíveis exigirão storage protegido com referência content-addressed e rights check;
- Job, ProviderCall, ProjectVersion, plan e evaluation ainda precisam entrar no grafo F0.025;
- a reexecução golden continuará aberta até RenderInput e parâmetros materializados estarem versionados.

Confirmação hospedada:

- o run `29289717455` aprovou os 20 passos no Linux no commit `1a58180`.

### Slice F0-017 — Parâmetros de recipe protegidos e endereçados por conteúdo

**Status:** publicado em 13 de julho de 2026 no commit `486c05f`; correção concorrente publicada no commit `094c0ee`.

Entregas:

- contrato interno aditivo `media-artifact-manifest/v3`, preservando leitura integral de v1 e v2;
- cada manifest v3 contém somente `parametersHash` e `parametersRef`, nunca o JSON bruto da recipe;
- o payload canônico é endereçado por `recipe-parameters/sha256/{hash}` e limitado a 1 MiB;
- serialização canônica garante que objetos semanticamente iguais gerem o mesmo hash/ref, independentemente da ordem das chaves;
- payload protegido com AES-256-GCM, nonce aleatório e contexto autenticado que inclui workspace e referência;
- key ID é validado e permanece apenas no registro interno; chave, plaintext, nonce, auth tag e ciphertext não são publicados;
- adapter de cifra isolado por port permite substituir KMS/provider sem acoplar domínio ou repository;
- Postgres e SQLite de protótipo armazenam payload, tamanho, algoritmo, key ID, nonce, ciphertext e auth tag;
- chave primária composta por workspace + referência permite conteúdo igual em workspaces distintos sem colisão nem compartilhamento indevido;
- deduplicação por workspace + parameters hash evita cifrar e armazenar novamente o mesmo payload dentro do workspace;
- manifest, vínculo com payload cifrado, artifact e lineage são persistidos na mesma transação;
- replay verifica referência, hash, tamanho e, quando a cifra está disponível, autentica e compara o plaintext canônico;
- leitura do artifact revalida o vínculo v3, mas o contrato `artifact-detail/v1` continua sem expor a referência protegida;
- capability externa `apollo.artifacts.replay-spec.read@1.0.0` usa o scope `artifacts:read`;
- endpoint `GET /v1/artifacts/{artifactId}/replay-spec/{manifestId}` publica apenas recipe/hash, disponibilidade, referência, tamanho e algoritmo;
- manifests v1/v2 respondem `available=false` e `REPLAY_PARAMETERS_MISSING`, sem inventar dados reproduzíveis;
- não existe endpoint público de descriptografia ou leitura do payload bruto.

Evidências locais:

- domínio comprova determinismo, ausência do segredo no manifest, round-trip cifrado e falha com contexto de outro workspace;
- integração Prisma comprova ciphertext sem plaintext, autenticação do payload armazenado e replay idempotente;
- a mesma recipe é deduplicada dentro do workspace e coexistiu de forma isolada em dois workspaces;
- duas transações concorrentes com outputs diferentes e a mesma recipe criaram ambos os artifacts e somente um payload protegido;
- API ponta a ponta comprova OpenAPI, capability discovery, scope 403, isolamento 404 e resposta sem plaintext/ciphertext/key ID;
- migration validada com 11 tabelas, 31 índices e 19 foreign keys;
- contratos aprovados com 14 capabilities, 18 schemas, 21 exemplos e 12 paths;
- suíte unitária passou para 41 testes;
- build Next.js registra a rota dinâmica de replay spec;
- integrações locais de artifact e API passaram no SQLite de protótipo.

Limites explícitos desta slice:

- a API informa se os parâmetros estão preservados, mas não autoriza sua recuperação;
- workers futuros receberão acesso interno mínimo via adapter/KMS e rights check, nunca pela API pública;
- rotação de chave, re-encriptação e auditoria de acesso ao plaintext serão uma slice de segurança separada;
- reconstrução golden agora possui o contrato RenderInput, mas ainda depende de ligá-lo ao manifest, materializar assets no worker e executar o renderer.

Incidente hospedado e correção:

- o primeiro run publicado (`29291985359`) aplicou a migration e passou até a integração concorrente de artifacts;
- o Postgres revelou uma corrida em que duas transações criavam outputs distintos com o mesmo payload novo;
- a transação perdedora agora relê um possível replay e, quando a colisão pertence apenas ao payload deduplicado, repete uma vez a transação completa;
- o run `29292143827` aprovou os 20 passos no Linux, incluindo migration, concorrência Postgres e API pública.

### Slice F0-018 — RenderInput portátil, preflight e materialização isolada

**Status:** concluído e publicado em 13 de julho de 2026 no commit `6683bca`.

Entregas:

- contrato de domínio fechado `render-input/v1` sem dependência de Next.js, Prisma, storage ou renderer;
- identidade do renderer inclui ID, versão e digest SHA-256 do bundle/tool;
- identidade da composição inclui ID, versão, referência explícita ao schema de props e hash canônico das props;
- vínculo com o plano inclui plan ID, version ID e plan hash;
- output incorpora `OutputSpec` versionado, safe areas, locale, formato, dimensões, FPS e duração exata em frames;
- assets são uma lista ordenada com ID lógico, artifact ID, canonical key, kind, role, ordinal, SHA-256 e byte size;
- kinds iniciais cobrem vídeo, áudio, imagem, fonte, LUT e dados auxiliares;
- props aceitam somente JSON canônico, rejeitando ciclos, valores não finitos, prototypes especiais e nomes perigosos;
- props são limitadas a 512 KiB canônicos, assets a 4.096 itens e duração a 12 horas no teto de 120 FPS;
- `propsHash` e `inputHash` são determinísticos e independentes da ordem das chaves do objeto;
- referências absolutas, traversal, campos extras e ordinals não contíguos são rejeitados;
- `RenderInputAssetResolver` materializa cada asset por port explícito, sem acesso implícito ao banco;
- materialização aceita somente HTTPS ou arquivo local, sem credenciais embutidas, e reconfirma checksum e byte size;
- URLs assinadas e paths de resolução dos assets existem apenas no objeto materializado em memória e não alteram nem entram no `inputHash`;
- capability `apollo.render-inputs.preflight@1.0.0` é pública, autenticada e usa `artifacts:read`;
- endpoint `POST /v1/render-inputs/preflight` possui idempotência natural e limita o body por streaming a 2 MiB;
- resposta pública informa hash e resumo seguro, sem devolver props, asset keys ou locations;
- resposta declara `validationScope=portable-envelope` e `materializationRequired=true`, evitando prometer validação das props específicas da composição;
- request/response possuem JSON Schemas, exemplos, OpenAPI e baseline de compatibilidade próprios.

Evidências locais:

- testes comprovam hash igual para props semanticamente iguais com chaves reordenadas;
- adulteração de `inputHash` e campo implícito de banco são rejeitados;
- materialização mantém a identidade portátil e não muta o spec de origem;
- checksum divergente retornado pelo resolver bloqueia a materialização;
- API ponta a ponta comprova capability discovery, scope 403, preflight 200 e input inválido 422;
- resposta ponta a ponta não contém props, canonical key nem URI;
- suíte unitária passou para 43 testes;
- contratos aprovados com 15 capabilities, 20 schemas, 23 exemplos e 13 paths;
- build Next.js registra `/v1/render-inputs/preflight` como rota dinâmica.

Limites explícitos desta slice:

- o preflight valida o envelope portátil e a canonicidade das props, não o schema semântico específico de cada composição;
- ainda não há adapter de storage que gere URL assinada nem adapter que converta o RenderInput v1 para as props da composição Remotion atual;
- o RenderInput ainda não está persistido/vinculado ao manifest v3;
- esta slice não inicia render, não gera custo e não acessa plaintext protegido;
- o próximo passo é persistir o RenderInput protegido no manifest e conectar um smoke render reconstruível.

Confirmação hospedada:

- o run `29324961708` aprovou os 20 passos no Linux, incluindo contratos públicos, build, integrações SQLite/Postgres e auditorias.

### Slice F0-019 — RenderInput protegido vinculado ao manifest v4

**Status:** concluído e publicado em 14 de julho de 2026 no commit `3b304c6`.

Entregas:

- contrato interno aditivo `media-artifact-manifest/v4`, preservando leitura de v1, v2 e v3;
- o manifest v4 mantém recipe e RenderInput como dois payloads protegidos independentes e content-addressed;
- o manifest publica somente `renderInput.ref` e `renderInput.inputHash`, nunca props, lista completa de assets ou JSON canônico;
- payload canônico `render-input/v1` limitado a 4 MiB e referenciado por `render-input/sha256/{inputHash}`;
- validação de payload reconfirma schema, hash, serialização canônica, referência e tamanho antes de persistir;
- cada source do manifest v4 deve existir entre os assets do RenderInput com a mesma canonical key e checksum;
- Postgres e SQLite de protótipo armazenam o RenderInput com AES-256-GCM, key ID, nonce, ciphertext e auth tag;
- contexto autenticado da cifra inclui workspace e referência, impedindo transplante silencioso entre tenants;
- deduplicação por workspace + input hash evita armazenar novamente o mesmo RenderInput no mesmo workspace;
- chave composta por workspace + referência mantém payloads iguais isolados entre workspaces;
- manifest, recipe protegida, RenderInput protegido, artifact e lineage são gravados na mesma transação;
- replay valida referência, hash, tamanho, metadados cifrados e plaintext canônico autenticado quando a cifra está disponível;
- constraints Postgres exigem recipe protegida em manifests v3/v4, RenderInput protegido em v4 e links nulos nas versões legadas;
- leitura interna revalida manifest, vínculos protegidos, artifact e lineage antes de produzir metadados seguros;
- capability externa `apollo.artifacts.render-input.read@1.0.0` usa scope `artifacts:read`;
- endpoint `GET /v1/artifacts/{artifactId}/render-input/{manifestId}` retorna somente ref, hash, tamanho e algoritmo;
- manifests v1/v2/v3 retornam `available=false` e `RENDER_INPUT_MISSING`;
- o presenter geral `artifact-detail/v1` continua sem publicar referências protegidas;
- JSON Schema, exemplos, OpenAPI e baseline foram ampliados de forma aditiva.

Evidências locais:

- domínio comprova manifest v4 determinístico, payload canônico válido e ausência das props protegidas no manifest;
- domínio rejeita source do manifest ausente dos assets do RenderInput;
- integração Prisma comprova ciphertext sem plaintext, round-trip autenticado e vínculo v4 íntegro;
- replay idempotente e dois manifests distintos reutilizam um único payload no workspace; a consulta interna devolve apenas metadados seguros;
- API ponta a ponta comprova capability discovery, scope 403, isolamento 404 e resposta legacy explícita;
- respostas `artifact-detail`, replay spec e RenderInput metadata não contêm props, canonical JSON, ciphertext ou key ID;
- migration validada com 12 tabelas, 34 índices e 21 foreign keys;
- contratos aprovados com 16 capabilities, 21 schemas, 25 exemplos e 14 paths;
- suíte unitária completa passou com 45 testes, incluindo 20 contratos de domínio;
- build Next.js registra a rota dinâmica de inspeção do RenderInput.

Limites explícitos desta slice:

- não existe endpoint público para descriptografar ou recuperar o JSON canônico;
- acesso futuro do worker ao plaintext exigirá adapter interno, rights check, auditoria e privilégio mínimo;
- fonts, LUTs e dados auxiliares já pertencem ao contrato do RenderInput, mas ainda precisam de storage tipado e adapters de materialização;
- schema semântico das props continua responsabilidade do adapter da composição;
- esta slice não inicia render e não implementa rotação ou reencriptação de chaves;
- o golden render permanece aberto até existir worker que recupere o payload protegido, materialize assets e execute o renderer somente a partir do manifest salvo.

Confirmação hospedada:

- o run `29326445993` aprovou os 20 passos no Linux, incluindo a migration real no Postgres 16, checkout de contracts, builds e integrações públicas.

### Slice F0-020 — Checkout autenticado e preflight de reconstrução

**Status:** concluído e publicado em 14 de julho de 2026 no commit `07409eb`.

Entregas:

- port interno `ProtectedRenderInputStore` recupera o payload somente por workspace, referência e input hash exatos;
- adapter Prisma abre AES-256-GCM com AAD workspace+ref, autentica o ciphertext e revalida schema, canonicidade, tamanho e `inputHash` antes de devolver o spec ao application service;
- payload ausente após um vínculo v4 válido é tratado como conflito de persistência, nunca como input vazio;
- contexto criptográfico de recipe e RenderInput foi centralizado para evitar divergência entre escrita e leitura;
- configuração preferencial usa `APOLLO_PROTECTED_PAYLOAD_KEY_ID` e `APOLLO_PROTECTED_PAYLOAD_KEY`, preservando fallback temporário dos nomes F0-017;
- `PrismaRenderInputAssetAvailability` verifica ownership de workspace, status disponível, artifact ID, canonical key, checksum, byte size e media kind;
- kinds ainda sem storage tipado (`font`, `lut`, `data`) falham fechados com `ASSET_KIND_UNSUPPORTED`;
- registry de render exige ID, versão e digest exatos do renderer;
- registry de composição exige ID, versão e `propsSchemaRef` exatos;
- digest ausente ou inválido na configuração torna o renderer indisponível, sem fallback silencioso;
- application service de preflight seleciona artifact/manifest exatos, autentica o RenderInput e verifica targets e assets em ordem determinística;
- resposta distingue `payloadAuthenticated`, `eligible`, `rightsValidationRequired` e `materializationRequired`;
- `eligible=true` significa apenas que identidade protegida, target técnico e assets atuais passaram; não autoriza nem inicia render;
- issues seguras distinguem manifest legacy, renderer/composição indisponíveis, asset ausente, indisponível, divergente ou ainda sem storage suportado;
- capability externa `apollo.artifacts.reconstruction.preflight@1.0.0` usa `artifacts:read`, custo free e idempotência natural;
- endpoint `POST /v1/artifacts/{artifactId}/reconstruction-preflight/{manifestId}` não aceita payload e não cria job ou custo;
- JSON Schema, exemplos, OpenAPI, baseline e `.env.local.example` foram atualizados.

Evidências locais:

- teste de domínio comprova preflight elegível, bloqueios determinísticos e comportamento legacy;
- resposta de domínio não contém props, logical asset ID nem canonical key protegidos;
- integração Prisma comprova round-trip do checkout e isolamento de workspace;
- alteração de um byte no ciphertext faz a autenticação falhar com conflito;
- integração Prisma comprova asset íntegro e detecta checksum divergente;
- API ponta a ponta comprova capability discovery, OpenAPI, scope 403, isolamento 404, v4 elegível e legacy bloqueado;
- resposta pública não contém props, asset key, ciphertext ou key ID;
- suíte unitária completa passou com 46 testes;
- contratos aprovados com 17 capabilities, 22 schemas, 27 exemplos e 15 paths;
- build Next.js registra a nova rota dinâmica de reconstruction preflight.

Limites explícitos desta slice:

- o preflight não materializa URL/path e não acessa o arquivo do asset;
- ownership e identidade não substituem rights, consent, disclosure ou policy snapshot;
- `eligible=true` não é promessa de que o render será aceito no commit futuro;
- ainda não existe `PublicOperation`, reserva de custo, worker isolado, heartbeat, cancel ou retry;
- nenhum endpoint devolve o `RenderInput` canônico descriptografado;
- o próximo passo é implementar rights gate e materialização auditável, então executar o smoke/golden render somente a partir deste checkout.

Confirmação hospedada:

- o run `29327471607` aprovou os 20 passos no Linux, incluindo migration Postgres, build de produção e integrações públicas.

### Slice F0-021 — Rights, consent e autorização auditável de materialização

**Status:** concluído e publicado em 14 de julho de 2026 no commit `fa3adb9`.

Entregas:

- contrato de domínio fechado `asset-rights/v1`, content-addressed e imutável por artifact;
- snapshots versionam owner, license, status, usos permitidos/proibidos, workspace, mercados, locales, operações sintéticas, expiração e nota de origem;
- consentimento possui status independente, finalidade, mercado, locale, operação sintética, expiração e referência opcional ao artifact de evidência;
- statuses `unknown`, `restricted`, `expired` e `revoked` falham fechados; ausência de snapshot nunca equivale a autorização;
- `not-required` é uma declaração explícita de consentimento, separada de `approved`;
- evaluator determinístico valida finalidade, proibição, workspace, território, locale, operação sintética e tempo;
- autorizações positivas possuem validade máxima de cinco minutos e sempre exigem revalidação no worker/commit;
- `V2AssetRightsSnapshot` preserva histórico e o artifact aponta para a revisão corrente sem alterar snapshots anteriores;
- replay natural de um PUT semanticamente idêntico reutiliza o snapshot pelo hash e não cria nova revisão;
- evidência de consentimento precisa existir no mesmo workspace e fica protegida por foreign key;
- `V2MaterializationAuthorization` registra target artifact, manifest, input hash, actor, request fingerprint, contexto, status, issues e validade;
- `V2AssetUseDecision` registra uma decisão ordenada por asset, snapshot avaliado, outcome, reason codes e validade;
- autorização usa `Idempotency-Key`; replay devolve o mesmo receipt e payload diferente com a mesma chave retorna conflito;
- o service autentica o RenderInput protegido, revalida renderer/composição/identidade dos assets e aplica rights/consent a todos os inputs;
- capability `apollo.artifacts.rights.read@1.0.0` expõe `GET /v1/artifacts/{artifactId}/rights` com `artifacts:rights`;
- capability `apollo.artifacts.rights.set@1.0.0` expõe `PUT /v1/artifacts/{artifactId}/rights` com `artifacts:rights`;
- capability `apollo.artifacts.materialization.authorize@1.0.0` expõe `POST /v1/artifacts/{artifactId}/materialization-authorizations/{manifestId}` com `artifacts:render`;
- receipts públicos não contêm props, canonical keys, URLs, paths, ciphertext, chaves nem notas jurídicas;
- JSON Schemas, exemplos, OpenAPI, capability discovery, baseline e constraints PostgreSQL foram ampliados aditivamente.

Evidências locais:

- testes de domínio comprovam hash canônico, imutabilidade, allow válido e bloqueios por mercado, consent unknown e rights ausente;
- service test comprova avaliação de todos os assets, locale derivado do RenderInput, validade curta e ausência de props/keys no receipt;
- API ponta a ponta comprova rights inicialmente ausentes, nega materialização, configura snapshot, autoriza, reproduz idempotentemente e rejeita reuso divergente da key;
- integração pública comprova uma autorização e uma decisão persistidas sem duplicata;
- scope filtering esconde as três capabilities de clients sem `artifacts:read`, `artifacts:rights` ou `artifacts:render`;
- migration valida 15 tabelas, 48 índices, 31 foreign keys e checks de status, hashes, JSON, outcome e validade;
- contratos aprovam 20 capabilities, 27 schemas, 33 exemplos e 17 paths;
- suíte unitária passa com 48 testes;
- build Next.js registra as rotas dinâmicas de rights e materialization authorizations;
- API completa passou em banco SQLite descartável; migration PostgreSQL e todos os gates hospedados também passaram.

Limites explícitos desta slice:

- o receipt autoriza a etapa, mas ainda não cria URL assinada, path local nem materializa bytes;
- o worker futuro deve reler os snapshots correntes imediatamente antes de resolver storage e antes de promover o output final;
- busca, Director, geração sintética e export ainda não consomem o gate central;
- não existe ainda fila de revisão administrativa para uso restricted;
- revogação cria um novo snapshot corrente, mas ainda não marca outputs downstream para review;
- fonts, LUTs e data continuam bloqueados até existir storage tipado;
- smoke/golden render continua pendente até materialização efetiva e execução isolada pelo manifest.

Confirmação hospedada:

- o run `29329930615` aprovou os 20 passos no Linux, incluindo migration Postgres, build de produção e integrações públicas.

### Slice F0-022 — Materialização efetiva e revalidação no worker

**Status:** concluído e publicado em 14 de julho de 2026 no commit `c15e023`.

Entregas:

- `materializeAuthorizedRenderInputService` aceita somente `workspaceId` e authorization ID, sem confiar em payload externo com locations ou props;
- repository de authorization ganhou lookup workspace-scoped e hidrata novamente o aggregate e suas decisões persistidas;
- autorização negada, ausente ou expirada é bloqueada antes de qualquer acesso aos bytes;
- artifact, manifest, protected RenderInput, renderer, composição, locale, assets e decisões são relidos e comparados com a autorização;
- rights/consent correntes são reavaliados imediatamente antes do storage; troca de snapshot exige nova autorização mesmo se o novo conteúdo ainda permitir o uso;
- `LocalArtifactRenderInputResolver` suporta `video`, `audio` e `image` a partir de `APOLLO_V2_ARTIFACT_ROOT`, sem aceitar raiz relativa;
- o resolver reconfirma no banco workspace, artifact ID, canonical key, status, kind, checksum e byte size antes de tocar no filesystem;
- `realpath` e containment impedem traversal e links que resolvam fora da raiz privada do worker;
- arquivo precisa ser regular e manter size, mtime, device e inode durante a leitura;
- SHA-256 e byte size reais são calculados em streaming e precisam coincidir com banco e RenderInput;
- assets são resolvidos deterministicamente em ordem, sem abrir até 4.096 streams simultâneos;
- locations ficam no `MaterializedRenderInput` imutável capturado pela lease interna; `JSON.stringify` da lease devolve apenas `materialized-render-input-receipt/v1`;
- o receipt seguro contém authorization/artifact/manifest/input hashes, contagem, revalidation hash e validade, sem path, URL, props, key ou nota jurídica;
- composition root do worker liga repositories, cipher, target registry, rights gate e resolver local sem criar acesso público ao storage;
- erros seguros distinguem autorização ausente, negada, expirada e falha de revalidação, sem incluir path na mensagem ou details;
- `.env.local.example`, ADR-001 e ADR-010 registram a configuração e os boundaries.

Evidências locais:

- suíte unitária completa passa com 50 testes;
- teste do worker comprova materialização autorizada, lease serializável sem location/props/key e receipt com revalidation hash;
- autorização no limite de validade é rejeitada antes do resolver;
- novo snapshot corrente, ainda permissivo, invalida a autorização antiga e não toca no storage;
- teste do adapter usa bytes reais em diretório temporário, confirma URI interna, checksum e tamanho;
- tentativa de usar key com traversal até arquivo existente fora da raiz é bloqueada;
- alteração dos bytes após o cadastro é detectada por tamanho ou SHA-256;
- lookup Prisma da autorização comprova hidratação completa e isolamento entre workspaces;
- integrações Prisma, artifacts e API completa passam em cópia SQLite descartável sincronizada com o schema, sem alterar o banco local existente;
- contratos permanecem em 20 capabilities, 27 schemas, 33 exemplos e 17 paths, sem expor a capability interna;
- typecheck, `git diff --check`, audits sem vulnerabilidades, migration validation, bundle Remotion e build Next.js passam.

Limites explícitos desta slice:

- a materialização é um boundary interno consumível pelo futuro render worker; não existe endpoint que devolva paths/URLs e a futura operação pública de render será o gatilho externo;
- ainda não existe job durável, fila, heartbeat, retry/cancel ou registro persistido da execução da materialização; o aggregate de autorização continua sendo o audit durável disponível;
- storage S3-compatible, signed URLs curtas e promoção multipart continuam pendentes;
- `font`, `lut` e `data` permanecem fail-closed até receberem storage tipado;
- esta slice não converte props para a composição Remotion nem executa o renderer;
- o worker que promover o output final deverá executar novamente o rights gate e verificar a validade da lease;
- smoke/golden render continua sendo o próximo incremento.
- PostgreSQL local não pôde ser repetido por ausência de Docker nesta máquina; a aplicação real das migrations e todas as integrações Postgres foram confirmadas pelo CI hospedado após a publicação.

Confirmação hospedada:

- o run `29331516521` aprovou todos os passos no Linux, incluindo migrations e integrações PostgreSQL, 50 testes, contratos, FFmpeg, Remotion e build Next.js.

### Slice F0-023 — Primeiro render autorizado a partir da lease

**Status:** publicado em 14 de julho de 2026 no commit `3843047`.

Entregas:

- o bundle Remotion agora registra a composition canônica `apollo-video`, preservando os IDs legacy `vertical` e `horizontal`;
- compiler fechado de `apollo://render-props/apollo-video/v1` transforma somente props protegidas e um `MaterializedRenderInput` em props da composição;
- `primaryVideoAssetId`, `imageAssetId` e `videoAssetId` são resolvidos contra a lease; referências ausentes ou kind incompatível falham fechadas;
- `imageSrc`, `imagePath` e `videoSrc` vindos diretamente das props de cena são rejeitados para impedir bypass do storage/rights gate;
- compiler valida composition/version/schema ref, output suportado, palette, cenas, ranges de frames, legendas e presets;
- `apollo-video/v1` suporta inicialmente `9:16` e `16:9`; os outros três formatos permanecem bloqueados para evitar layout incorreto silencioso;
- novo port `RenderInputRenderer` separa stage, commit e discard e nunca inclui output path no receipt;
- `RemotionRenderInputRenderer` executa o subprojeto isolado, recebe request/props por stdin e limita timeout e volume de stdout/stderr;
- asset `file:` é servido ao Chromium somente por HTTP efêmero em `127.0.0.1`, com token aleatório, allowlist exata, MIME, HEAD e byte ranges;
- apenas campos de location produzidos pelo compiler são convertidos; strings comuns, prompts, títulos e textos não são interpretados como paths;
- o render nasce como partial irmão dentro de `APOLLO_V2_RENDER_OUTPUT_ROOT` e a output key precisa ser portátil e permanecer sob a raiz real;
- stage valida arquivo regular e não vazio, dimensões, fps, duração, SHA-256, byte size e identidade antes/depois do hash;
- `renderAuthorizedInputService` repete a materialização completa após o encode e antes do commit;
- promoção exige os mesmos `inputHash` e `revalidationHash`; expiração, revogação, mudança dos bytes ou cancelamento descartam o partial;
- commit reconfirma identidade do partial e ausência de output preexistente antes do rename no mesmo filesystem;
- receipt final contém apenas IDs/hashes, probe, codec/container, tamanho e horário de commit;
- composition root cria o executor interno a partir de artifact root, output root, repositories, rights gate e timeout configurado;
- smoke render real foi adicionado ao CI imediatamente depois do bundle Remotion.

Evidências locais:

- suíte unitária passa com 52 testes;
- testes do compiler comprovam resolução por asset ID e rejeição de URL direta em props;
- teste de orchestration comprova duas materializações, commit somente após igualdade e discard diante de revalidation hash divergente;
- smoke cria fonte audiovisual real com FFmpeg, materializa os bytes pela lease, renderiza a composition `apollo-video` e promove um MP4 H.264 real;
- output smoke possui 270×480, 30 fps, aproximadamente um segundo, byte size positivo e SHA-256 igual ao receipt;
- diretório final contém somente `smoke.mp4`, sem arquivo partial;
- receipt serializado não contém `file:`, artifact key nem diretório temporário;
- `npm test` passa com 52/52 testes e typecheck sem erros;
- contrato público permanece compatível com 20 capabilities, 27 schemas, 33 exemplos e 17 paths;
- migration v2 permanece válida com 15 tabelas, 48 índices e 31 foreign keys;
- auditorias do app e do subprojeto Remotion reportam zero vulnerabilidades;
- build Next.js, bundle Remotion, integração FFmpeg e smoke render real passam;
- integrações de repository, artifacts e Public API passam em SQLite temporário isolado;
- `git diff --check` passa após as proteções finais.

Limites explícitos desta slice:

- o smoke parte de manifest/protected store/repositories em memória; replay a partir de um manifest realmente persistido continua aberto;
- o output ainda não é persistido como `V2MediaArtifact`/manifest/lineage e não existe audit durável do stage/commit;
- ainda não existe `PublicOperation`, fila, heartbeat, retry, cancel persistido ou endpoint externo de render;
- compiler v1 ainda não leva creator, layout segments, punch-ins, cold open, trilha/SFX, LUT, fonts ou data ao renderer;
- `4:5`, `1:1` e `21:9` permanecem fail-closed no compiler atual;
- o smoke valida identidade e probe, não igualdade binária cross-platform nem tolerância visual/áudio de um golden;
- o servidor de assets é um bridge local temporário; object storage usará HTTPS assinada curta em adapter separado;
- o próximo incremento deve persistir a operação/output/lineage e expor o comando de render assíncrono pela Public API sem devolver internals.

Confirmação hospedada:

- o run `29333211765` aprovou todos os passos no Linux, incluindo o novo smoke Remotion autorizado, migrations PostgreSQL, contratos, builds e integrações.

### Slice F0-024 — Operação pública durável para render autorizado

**Status:** publicado em 14 de julho de 2026 nos commits `8486ca0` e `2f3f38e`.

Entregas:

- `public-operation/v1` define estados `queued/running/waiting/retrying/succeeded/failed/canceled`, fases fechadas, progresso, flags de cancel/retry, target, result/error e tentativas;
- invariantes rejeitam operações queued adulteradas, progresso impossível, target inseguro, datas incoerentes e estados terminais incompletos;
- persistência separa `public_operations`, genérica, de `artifact_render_operations`, contexto tipado do render sem blob genérico;
- constraints PostgreSQL cobrem type/status/phase/target, progresso, tentativas, fingerprint, JSON, erro, coerência de estado e datas;
- FKs ligam workspace, API client, artifact, manifest e autorização; o adapter reconfirma que todos pertencem ao mesmo contexto e que authorization/input hash/client/status continuam coerentes;
- `PrismaPublicOperationRepository` implementa criação/replay atômicos por workspace+client+idempotency key, conflito por fingerprint divergente e leitura workspace-scoped;
- `enqueueAuthorizedRenderService` aceita somente autorização do mesmo client, autorizada, não expirada e vinculada ao artifact/manifest exatos;
- `POST /v1/artifacts/{artifactId}/renders/{manifestId}` retorna `202` com uma operação queued e nunca executa mídia no processo web;
- `GET /v1/operations/{operationId}` exige `operations:read` e devolve somente o presenter público seguro;
- capability registry, OpenAPI, três JSON Schemas/examples e baseline de compatibilidade foram atualizados;
- o CI ganhou uma integração dedicada de persistência de operações duráveis.

Regressões e evidências locais:

- suíte unitária passa com 54 testes;
- regressões de domínio cobrem imutabilidade, invariantes fail-closed, expiração, actor binding, replay e ausência de internals no presenter;
- integração Prisma comprova persistência/replay, isolamento de workspace, conflito de idempotência e detecção de target ou input hash adulterado;
- integração HTTP comprova discovery/OpenAPI, enqueue 202, replay, payload divergente 409, body extra 422, read 200 e missing operation 404;
- respostas públicas não contêm workspace/client internos, authorization ID, RenderInput hash, artifact key, path ou `file:`;
- contratos permanecem compatíveis com 22 capabilities, 30 schemas, 36 exemplos e 19 paths;
- migration v2 permanece válida com 17 tabelas, 56 índices e 38 foreign keys;
- typecheck, build Next.js, testes unitários, integração de operação, integração pública e `git diff --check` passam durante o desenvolvimento.

Limites explícitos desta slice:

- a operação permanece `queued`; ainda não há claim/lease, heartbeat, CAS de transição ou recuperação após restart;
- listagem, filtros, cancel e retry públicos continuam abertos;
- o worker ainda não persiste `running`, fases, resultado, erro, custo ou audit de stage/commit;
- o output do F0-023 ainda não é ligado à operação persistida nem conferido contra o artifact/manifest target;
- apenas `artifact-render` está implementado; ingest, Director, providers, sync, batch e export ainda não usam `PublicOperation`;
- o próximo incremento deve implementar claim/lease durável, executar o render autorizado fora do processo web e persistir o resultado terminal seguro.

Confirmação hospedada:

- o run inicial `29335940403` detectou uma fixture com `createdAt` futuro em relação ao relógio do runner, sem falha das constraints de produção;
- a correção `2f3f38e` estabilizou a fixture mantendo as proteções intactas;
- o run final `29336169905` aprovou migrations PostgreSQL, render Remotion real, persistência de artifacts/operações, API, contratos, builds e auditorias.

### Slice F0-025 — Worker durável com lease e fencing

**Status:** publicado em 14 de julho de 2026 no commit `5de6a36`.

Entregas:

- processo `worker:v2:render` separado da aplicação web busca e executa operações persistidas;
- `public_operations` ganhou owner, expiração e heartbeat de lease, constraint de coerência e índice de claim;
- claim aceita queued/retrying ou running expirado, incrementa attempt e persiste `materializing` atomicamente;
- attempt atua como fencing token: heartbeat, fase, sucesso e falha exigem owner/tentativa/lease válidos;
- recuperação de lease expirada preserva o primeiro `startedAt`, incrementa attempt e invalida comandos do worker antigo;
- fases seguem ordem monotônica e são persistidas por CAS;
- heartbeat periódico aborta o renderer quando a lease é perdida ou o banco deixa de confirmar a renovação;
- o executor ganhou gate assíncrono depois da segunda materialização e antes do commit;
- esse gate renova a lease e grava `persisting`; rejeição descarta o partial antes da promoção;
- receipt precisa coincidir com authorization, artifact, manifest e input hash da operação reclamada;
- sucesso grava somente referência segura a artifact/manifest e limpa a lease;
- falha retryable volta a `retrying` enquanto houver attempts; ao esgotar, grava erro terminal sanitizado;
- ADR-014 formaliza restart, fencing, janela pré-commit e limites da transação distribuída.

Regressões e evidências locais:

- transições de domínio rejeitam retrocesso de fase, tempo regressivo, sucesso antes de `persisting` e tentativa além do máximo;
- teste de orchestration comprova que o gate pré-commit rejeitado executa discard e nunca commit;
- testes do worker cobrem sucesso, perda de lease, ausência de internals, retry e retomada na segunda tentativa;
- integração Prisma cobre claim único, disputa concorrente no PostgreSQL, heartbeat com attempt incorreto, renovação, expiração, reclaim, fase/conclusão stale bloqueada e limpeza terminal da lease;
- typecheck e validação da migration passam; o schema v2 possui 17 tabelas, 57 índices e 38 foreign keys;
- integração dedicada passa em cópia SQLite temporária sem alterar o banco local.

Limites explícitos desta slice:

- backoff, cancelamento, retry manual e descoberta de dead-letter foram entregues nos F0-027 a F0-031; métricas e administração agregada continuam abertas;
- ainda não existe checkpoint posterior ao commit que prove que os bytes materializados correspondem ao artifact/manifest alvo;
- queda depois do commit do arquivo e antes do `succeeded` ainda depende da output key determinística; a reconciliação será fechada junto à persistência do output;
- `verifying` existe no contrato e no repository, mas probe/quality ainda ocorre dentro do renderer e não ganha fase separada;
- lease/heartbeat são internos e deliberadamente não aparecem na Public API;
- hosted CI `29340825051` aprovou migrations PostgreSQL, concorrência de claim, 58 testes, contratos, FFmpeg, Remotion real, build, persistência e API.

### Slice F0-026 — Checkpoint durável do output renderizado

**Status:** publicado em 14 de julho de 2026 nos commits `9e6451a` e `b14091b`.

Entregas:

- `artifact_render_operations` ganhou checkpoint tipado do output com storage key interna, SHA-256, byte size, dimensões, fps, frames, codec/container, attempt e datas;
- constraint PostgreSQL exige ausência total ou checkpoint completo e tecnicamente válido;
- `PrismaArtifactRenderCheckpointRepository` valida o manifest canônico e reconfirma workspace, target artifact/manifest, input hash, hash/tamanho do artifact, container e probe;
- gravação exige operação `running/persisting`, owner, attempt e lease válidos no mesmo transaction boundary;
- worker antigo não consegue registrar output depois de perder o fencing token;
- replay aceita stage/horário de observação diferentes somente quando a identidade imutável dos bytes permanece exata;
- `succeeded` agora é recusado enquanto o checkpoint do output não existir;
- `renderAuthorizedInputService` devolve a storage key somente por getter interno; `toJSON` e o presenter público continuam sem key/path;
- renderer inspeciona output determinístico já comprometido, recalcula hash/probe e o reutiliza sem nova codificação;
- output recuperado passa novamente pela materialização, rights revalidation e gate de lease antes de ser aceito;
- checkpoint permite retomar tanto a queda depois do commit físico quanto a queda depois do registro e antes do status terminal;
- target adulterado ou checkpoint cujo hash diverge do artifact falha fechado também no SQLite, não apenas nas constraints PostgreSQL.

Regressões e evidências locais:

- suíte unitária passa com 59 testes;
- orchestration cobre recuperação sem chamar `stage` novamente e confirma que a storage key não serializa;
- worker cobre commit concluído, checkpoint perdido, lease expirada, reclaim e conclusão na tentativa seguinte;
- smoke Remotion real renderiza uma vez e recupera o mesmo MP4 na segunda execução, sem criar arquivos adicionais;
- integração Prisma exige checkpoint antes do sucesso, bloqueia tentativa stale, comprova replay e detecta adulteração do output SHA;
- typecheck, migration validation e integração SQLite descartável passam durante o desenvolvimento.

Limites explícitos desta slice:

- artifact e manifest alvo já existem antes da reconstrução; esta slice registra a materialização efetiva dos bytes, não cria um segundo artifact concorrente;
- comparação binária cross-platform não é assumida; o endpoint de reconstrução exige identidade com o target persistido e falha se o renderer produzir bytes diferentes;
- storage S3-compatible e reconciliação/limpeza administrativa de outputs inválidos continuam abertos;
- ainda falta uma fixture única que combine Postgres persistido, storage real e Remotion em um golden tolerante;
- cancelamento, custo e audit/event outbox continuam em incrementos posteriores;
- hosted CI `29343481216` aprovou 59 testes, migrations PostgreSQL, persistência, API, FFmpeg, Remotion real com recuperação, build e auditorias.

### Slice F0-027 — Retry durável, backoff e esgotamento

**Status:** publicado em 14 de julho de 2026 no commit `d80f14c`.

Entregas:

- `public_operations` ganhou `nextAttemptAt` e `deadLetteredAt`, com constraint de coerência e índice de disponibilidade;
- a migration inicializa com espera segura qualquer operação `retrying` já existente antes de validar a nova constraint;
- falha recuperável agenda atraso exponencial determinístico de 5 segundos, dobrando por tentativa até o teto padrão de 5 minutos;
- base e teto são configuráveis no worker e valores incompatíveis falham fechados;
- `claimNext` exclui retries prematuros e aceita o boundary exato de `nextAttemptAt`;
- o domínio repete a proteção temporal, limpa o agendamento ao iniciar a tentativa e impede schedule em falha terminal;
- esgotamento de erro recuperável ou de lease expirada grava `deadLetteredAt` junto da conclusão;
- falhas não recuperáveis continuam distinguíveis porque não recebem marcação de dead-letter;
- presenter e schema público v1 permanecem inalterados; datas internas não vazam nem quebram integrações existentes;
- ADR-016 formaliza a política e reserva contrato versionado próprio para administração/replay externo.

Regressões e evidências locais:

- suíte unitária passa com 61 testes;
- testes cobrem progressão 5/10/20/40 segundos, teto de 5 minutos e tentativa extrema sem overflow;
- domínio recusa tentativa 1 ms antes do agendamento e aceita o instante exato;
- worker cobre restart após espera, sucesso posterior e esgotamento sanitizado;
- integração Prisma cobre persistência do schedule, claim prematuro nulo, claim no boundary, limpeza do schedule e dead-letter terminal;
- migração possui verificação estática da constraint e o schema passa com 17 tabelas, 58 índices e 38 foreign keys;
- typecheck e contrato público v1 passam sem alteração de schema.

Limites explícitos desta slice:

- `deadLetteredAt` é checkpoint durável; retry manual, listagem geral e descoberta de dead-letter foram expostos nos F0-029 a F0-031;
- cancelamento cooperativo e command público foram entregues no F0-028;
- a política é aplicada ao worker de render; outros tipos de job deverão reutilizar a mesma semântica;
- jitter determinístico, quotas, custo por tentativa e alertas operacionais ficam para incrementos posteriores;
- hosted CI `29347614345` aprovou 61 testes, migrations PostgreSQL, persistência, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-028 — Cancelamento cooperativo e externo

**Status:** publicado em 14 de julho de 2026 no commit `5991987`.

Entregas:

- `cancelPublicOperation` torna cancelamento terminal e idempotente, preservando tentativa, início e o primeiro timestamp terminal;
- repository cancela `queued`, `waiting`, `retrying` e `running` no banco, limpando lease, heartbeat e agendamento atomicamente;
- operações `succeeded`, `failed` ou já `canceled` são devolvidas sem reescrita;
- cancelamento de uma tentativa ativa faz heartbeat, avanço de fase, checkpoint, conclusão e reclaim falharem fechados;
- `POST /v1/operations/{operationId}/cancel` expõe o command para automação externa;
- capability `apollo.operations.cancel` exige autenticação, scope `operations:cancel`, usa idempotência natural e anuncia confirmação humana;
- resposta reutiliza o schema seguro `public-operation-detail/v1` e não expõe lease, storage, autorização ou input hash;
- baseline público foi atualizado de forma aditiva para 23 capabilities e 20 paths;
- ADR-017 formaliza semântica terminal, corrida com claim/conclusão e limite de rollback de efeitos externos.

Regressões e evidências locais:

- suíte unitária passa com 63 testes;
- domínio cobre cancelamento queued e retrying, limpeza do schedule e replay com timestamp estável;
- worker cobre cancelamento durante render e comprova ausência de commit/checkpoint;
- integração Prisma cobre isolamento por workspace, queued, retrying, running/persisting, lease e checkpoint stale;
- integração PostgreSQL disputa claim e cancel em paralelo, exigindo estado final canceled e invalidando eventual lease retornada;
- jornada HTTP cobre scope negado, cancelamento, replay, leitura posterior e target inexistente;
- typecheck, contratos públicos, build e integração SQLite descartável passam.

Limites explícitos desta slice:

- cancelamento é cooperativo; renderer/provider que ignora `AbortSignal` pode continuar consumindo até o próximo gate, mas não pode publicar;
- bytes promovidos na janela entre commit físico e checkpoint não são apagados automaticamente e exigirão reconciliação/retention;
- ator/motivo persistidos, event outbox, custo consumido e métricas de cancelamento continuam no incremento de audit/cost;
- retry manual foi entregue no F0-029, listagem no F0-030 e descoberta de dead-letter no F0-031; métricas e administração agregada continuam abertas;
- hosted CI `29350400758` aprovou 63 testes, corrida claim/cancel no PostgreSQL, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-029 — Retry manual e replay controlado

**Status:** publicado em 14 de julho de 2026 no commit `b25513e`.

Entregas:

- `retryPublicOperation` reabre somente operações `failed` ou `canceled`, preservando ID, target, contexto protegido, checkpoint e histórico de attempts;
- canceled com `attempt = 0` volta para `queued`; operações com tentativa anterior voltam para `retrying` com disponibilidade persistida 1 ms depois;
- dead-letter esgotado recebe exatamente uma nova vaga em `maxAttempts`; capacidade ainda disponível não é ampliada;
- `succeeded` retorna conflito tipado e nunca perde resultado;
- chamadas sobre estados não terminais são replay natural e não concedem tentativas adicionais;
- repository limpa conclusão/error/dead-letter, mantém fencing e resolve duas chamadas concorrentes com uma única transição;
- `POST /v1/operations/{operationId}/retry` expõe o command com scope `operations:retry` e confirmação humana;
- response reutiliza `public-operation-detail/v1`, sem copiar ou expor autorização, RenderInput ou storage;
- baseline público foi atualizado para 24 capabilities e 21 paths;
- ADR-018 formaliza reabertura, capacidade, idempotência e revalidação obrigatória.

Regressões e evidências locais:

- suíte unitária passa com 64 testes;
- domínio cobre queued não terminal, canceled antes da primeira tentativa, dead-letter esgotado, nova attempt e rejeição de sucesso;
- integração Prisma cobre isolamento por workspace, replay imediato, boundary temporal, aumento único de `maxAttempts` e claim após retry;
- integração PostgreSQL executa duas chamadas de retry concorrentes e comprova que não há concessão dupla;
- jornada HTTP cobre scope negado, cancel → retry, replay, leitura posterior e operação ausente;
- typecheck, contrato público, build e integrações SQLite descartáveis passam.

Limites explícitos desta slice:

- retry reaproveita a autorização original, mas não ignora expiração, revogação ou nova decisão de rights;
- cada nova falha terminal requer um novo command explícito; não há loop manual implícito;
- budget, quota, motivo, ator persistido, event outbox e custo por tentativa continuam abertos;
- listagem e filtros seguros foram entregues no F0-030 e descoberta de dead-letter no F0-031; métricas e console agregada continuam abertas;
- hosted CI `29351454953` aprovou 64 testes, retry concorrente no PostgreSQL, contratos, migrations, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-030 — Listagem externa e cursor estável de operações

**Status:** publicado em 14 de julho de 2026 no commit `829d2eb`.

Entregas:

- `GET /v1/operations` lista somente operações do workspace autenticado com scope `operations:read`;
- a ordem fixa `createdAt DESC, id DESC` resolve empates e sustenta uma fronteira determinística;
- paginação usa `limit`, `after` e `nextCursor`, com padrão 20 e teto 100;
- cursor Base64 URL-safe v1 carrega apenas fronteira e hash da combinação workspace/filtros, sem segredo ou contexto operacional;
- continuar um cursor com workspace, status, type ou target diferentes falha com `INVALID_ARGUMENT`;
- filtros atuais são `status`, `type` e `targetId`; parâmetros desconhecidos, repetidos ou fora da allowlist são rejeitados;
- repository busca uma unidade adicional para decidir honestamente se há próxima página;
- índice composto workspace/criação/ID foi adicionado ao SQLite e ao PostgreSQL, com migration própria;
- capability `apollo.operations.list`, OpenAPI, schema `public-operation-list/v1`, exemplos e baseline foram publicados de forma aditiva;
- ADR-019 registra semântica do cursor, consistência, segurança e limite explícito do filtro por projeto.

Regressões e evidências locais:

- suíte unitária passa com 65 testes;
- application service cobre cursor opaco, boundary, mudança de filtros/workspace e valores inválidos;
- integração Prisma cobre empate de timestamp, desempate por ID, continuação sem duplicação, workspace e target ausentes;
- jornada HTTP cobre scope negado, duas páginas, página terminal, filtros vazios, cursor incompatível e parâmetros desconhecidos/repetidos;
- payload listado não contém authorization, input hash, storage ou paths locais;
- contrato público passa com 25 capabilities, 31 schemas, 38 examples e 22 paths;
- migration v2 passa com 17 tabelas, 59 índices e 38 foreign keys;
- typecheck, build de produção e integrações SQLite descartáveis de operação/API passam.

Limites explícitos desta slice:

- paginação é estável, mas não constitui snapshot transacional; exclusões e mudanças de status concorrentes podem alterar páginas filtradas;
- somente `artifact-render` existe no contrato atual; novos job types ampliarão a allowlist de forma aditiva;
- `projectId` não é fingido a partir de artifact: depende de associação canônica e indexada entre operação e projeto;
- intervalos de data, ordenações alternativas e filtros combinados adicionais continuam abertos;
- descoberta de dead-letter foi entregue no F0-031; métricas agregadas, custo, audit/event outbox e ator/motivo persistidos continuam em incrementos posteriores;
- hosted CI `29358838402` aprovou 65 testes, paginação no PostgreSQL, migration, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-031 — Descoberta externa de dead-letter

**Status:** publicado no commit `8b9d9f7` em 14 de julho de 2026.

Entregas:

- capability aditiva `apollo.operations.dead-letter.list` publica `GET /v1/operations/dead-letter` sem alterar o contrato já publicado da listagem geral;
- scope `operations:read` permite descobrir somente esgotamentos do workspace autenticado;
- repository exige `status = failed` e `deadLetteredAt IS NOT NULL`, excluindo falhas definitivas que nunca foram elegíveis a retry automático;
- response reutiliza `public-operation-list/v1` e não expõe `deadLetteredAt`, schedule, lease, authorization, RenderInput ou storage;
- `completedAt` permanece como timestamp terminal público e coincide com o checkpoint interno pela invariável de persistência;
- paginação mantém `createdAt DESC, id DESC`, limite 20/100 e cursor vinculado também ao modo dead-letter;
- filtros externos são `type` e `targetId`; status, parâmetros desconhecidos/repetidos e cursor incompatível falham com `INVALID_ARGUMENT`;
- retry individual limpa o checkpoint atomicamente e remove a operação das consultas administrativas posteriores;
- índice workspace/dead-letter/criação/ID foi adicionado aos schemas e à migration PostgreSQL;
- ADR-020 registra fronteira de segurança, relação com retry e limites administrativos.

Regressões e evidências locais:

- suíte unitária passa com 66 testes;
- application service cobre imposição de `failed + deadLettered`, cursor e incompatibilidade com modo sem dead-letter;
- integração Prisma comprova inclusão do esgotamento e exclusão de falhas sem checkpoint;
- jornada HTTP cobre scope negado, duas páginas, filtros, parâmetros inválidos e ausência de contexto protegido;
- fluxo E2E lista duas operações esgotadas, executa retry em uma e comprova que somente a outra permanece;
- contrato público passa com 26 capabilities, 31 schemas, 38 examples e 23 paths;
- migration v2 passa com 17 tabelas, 60 índices e 38 foreign keys;
- typecheck, build de produção e integrações SQLite descartáveis de operação/API passam.

Limites explícitos desta slice:

- a listagem informa esgotamento, mas não garante que rights, consent, autorização, quota ou provider ainda permitam nova conclusão;
- não há retry em lote, replay automático, acknowledgement, purge ou política de retenção nesta etapa;
- métricas, alertas, custo, ator/motivo persistido e audit/event outbox continuam abertos;
- somente `artifact-render` participa até a generalização dos demais tipos de job;
- hosted CI `29359738397` aprovou 66 testes, fluxo dead-letter no PostgreSQL, migration, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-032 — Envelope e catálogo inicial de eventos

**Status:** publicado no commit `b9a999c` em 14 de julho de 2026.

Entregas:

- tipo canônico `PublicEvent<T>` fixa ID, tipo, versão, workspace, instante, ator opcional, recurso e payload JSON;
- IDs são UUID v4 normalizados e a criação em lote rejeita duplicação antes da persistência;
- catálogo inicial imutável registra 14 tipos versionados e o `resource.type` permitido para cada evento;
- fábrica de domínio rejeita tipo/versão/recurso incompatíveis, timestamp fora do UTC canônico, sequência inválida e ator vazio;
- payload é copiado e congelado profundamente, limitado a 64 KiB, profundidade 8 e 1.024 itens por coleção;
- ciclos, objetos não JSON, números não finitos e chaves que permitiriam prototype pollution falham com erro de domínio tipado;
- capability aditiva `apollo.events.catalog.read` publica `GET /v1/events/catalog` sem autenticação e sem dados de workspace;
- schemas `public-event/v1` e `event-catalog/v1`, exemplos, OpenAPI e baseline foram ampliados de forma aditiva;
- ADR-021 separa explicitamente disponibilidade do contrato de emissão ou entrega efetiva.

Regressões e evidências locais:

- suíte unitária passa com 68 testes;
- domínio cobre catálogo exato, UUID v4, imutabilidade, unicidade em lote e matriz de payloads inválidos;
- contract test impede divergência entre catálogo e enum do schema público;
- jornada HTTP lê schema e catálogo sem credencial, valida os 14 tipos e comprova ausência de contexto de workspace;
- contrato público passa com 27 capabilities, 33 schemas, 40 examples e 24 paths;
- typecheck, build de produção e compatibilidade aditiva do baseline passam;
- migration v2, FFmpeg, bundle e render real do Remotion, auditorias e integrações Prisma/API em SQLite descartável passam.

Limites explícitos desta slice:

- unicidade global ainda depende da futura chave única do outbox; a garantia atual cobre geração válida e lotes em memória;
- nenhum dos 14 tipos é considerado emitido apenas por estar catalogado;
- outbox, subscriptions, endpoints receptores, secrets, filtros e delivery attempts continuam abertos;
- assinatura, challenge, anti-replay, at-least-once, backoff e replay de eventos continuam abertos;
- ordem entre eventos não é prometida até existir persistência e semântica operacional para `sequence`;
- hosted CI `29361121900` aprovou 68 testes, contratos, migration PostgreSQL, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-033 — Outbox transacional de criação de projeto

**Status:** publicado no commit `81c619d` em 14 de julho de 2026.

Entregas:

- tabela interna `V2PublicEventOutbox` foi adicionada ao protótipo SQLite e ao schema PostgreSQL;
- UUID v4 do evento é chave primária global e cada linha preserva workspace, tipo, versão, instante, sequence, ator, recurso e data JSON;
- `publishedAt` nulo representa evento durável ainda não publicado, sem fingir entrega ou subscription;
- criação de projeto produz `project.created` e `project.version.created` no application service;
- projeto, versão inicial, snapshots, idempotency record e dois eventos são gravados na mesma transação;
- replay idempotente retorna o resultado original sem inserir novos eventos;
- colisão global de event ID é traduzida em conflito de persistência e reverte toda a criação;
- constraints PostgreSQL limitam tipo, versão, sequence, ator, recurso, payload JSON de 64 KiB e datas;
- índices preparam polling pendente, inspeção por workspace e busca por recurso;
- ADR-022 registra a fronteira entre persistência transacional e futura publicação/entrega.

Regressões e evidências locais:

- suíte unitária passa com 68 testes e valida os dois envelopes produzidos pela criação;
- integração Prisma comprova exatamente dois eventos, replay sem duplicação e rollback completo por colisão de ID;
- jornada HTTP comprova que criação e replay externos deixam apenas os dois eventos pendentes esperados;
- migration v2 passa com 18 tabelas, 64 índices e 39 foreign keys;
- contratos públicos permanecem intactos com 27 capabilities, 33 schemas, 40 examples e 24 paths;
- typecheck e build de produção passam;
- FFmpeg, bundle/render real do Remotion, auditorias e todas as integrações Prisma/API em SQLite descartável passam.

Limites explícitos desta slice:

- somente criação de projeto e versão inicial estão conectadas; demais domain/workflow transitions continuam abertas;
- `publishedAt` não é alterado porque ainda não existe dispatcher ou destino durável de publicação;
- não existem subscriptions, endpoints receptores, filtros, secrets ou delivery attempts;
- claim/lease, at-least-once, assinatura, challenge, anti-replay, backoff, dead-letter e replay de eventos continuam abertos;
- a tabela é infraestrutura interna e não será exposta crua; administração externa virá por capabilities seguras;
- hosted CI `29369679232` aprovou outbox e rollback no PostgreSQL, 68 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-034 — Modelo durável de subscriptions e deliveries

**Status:** concluído e publicado em 14 de julho de 2026 no commit `5c25804`.

Entregas:

- domínios canônicos foram criados para endpoint, signing secret, subscription, filtro, delivery e delivery attempt;
- endpoint novo fica `pending-verification` e aceita somente URL HTTPS normalizada, porta 443 e hostname DNS não local;
- credentials, query, fragment, localhost, sufixos locais e IP literal são rejeitados antes da persistência;
- signing secret é versionado, usa `hmac-sha256` e persiste somente referência opaca e fingerprint, nunca material secreto;
- filtro usa 1 a 100 tipos exatos do catálogo, resource IDs opcionais, ordenação determinística e hash estável;
- endpoint, secret inicial e subscription são registrados atomicamente para workspace e client ativos;
- duplicidade de URL/filtro/key ref ou client ausente reverte todo o registro;
- delivery é única por subscription/event e delivery attempt possui identidade e ordinal próprios;
- cinco tabelas novas, relações workspace-scoped, índices de polling/deduplicação e constraints de estado foram adicionados;
- CI passa a executar a integração dedicada de persistência de webhooks;
- ADR-023 registra a fronteira entre configuração durável e futura execução de rede.

Regressões e evidências locais:

- suíte unitária passa com 71 testes;
- testes de domínio cobrem normalização, imutabilidade, catálogo exato, URLs inseguras, filtros ambíguos e secret material indevido;
- integração Prisma comprova registro atômico, isolamento por workspace, referência sem segredo, rollback por duplicidade e client inexistente;
- migration v2 passa com 23 tabelas, 81 índices e 51 foreign keys;
- contratos públicos permanecem intactos com 27 capabilities, 33 schemas, 40 examples e 24 paths;
- typecheck, geração dos clients Prisma e build de produção passam;
- FFmpeg, bundle/render real do Remotion, auditorias e todas as integrações Prisma/API em SQLite descartável passam.

Limites explícitos desta slice:

- validação de hostname ainda não resolve DNS; challenge e conexão deverão bloquear redes privadas e DNS rebinding a cada uso;
- não existe provider adapter para provisionar/abrir o secret nem exibição one-shot;
- endpoint e subscription agora podem ser ativados atomicamente pelo núcleo de challenge do F0-035; o envio HTTPS seguro do challenge continua aberto;
- deliveries ainda não são materializadas a partir do outbox e nenhuma chamada HTTPS é executada;
- transporte de challenge, secret provider, claim/lease, at-least-once, backoff, dead-letter e replay continuam abertos;
- API/UI administrativa e presenters seguros continuam no incremento administrativo posterior;
- hosted CI `29371680964` aprovou persistência PostgreSQL, 71 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-035 — Challenge, assinatura e anti-replay de webhook

**Status:** concluído e publicado em 14 de julho de 2026 no commit `1485c19`.

Entregas:

- challenge one-shot usa 256 bits de entropia e persiste somente SHA-256, nunca o token original;
- TTL e limite de tentativas são validados, tentativas incorretas são duráveis e expiração/esgotamento são terminais;
- emissão substitui challenge pendente anterior e a verificação correta ativa endpoint e subscriptions na mesma transação;
- HMAC-SHA256 cobre versão, timestamp, event ID e bytes exatos do body, com comparação em tempo constante;
- chave, versão, timestamp, event ID, assinatura e body inválidos falham com erro uniforme de assinatura;
- timestamp aceita janela limitada e configurável; payload assinado é limitado a 256 KiB;
- receipt durável e único por endpoint/event impede replay concorrente e permite substituição somente após expiração;
- duas tabelas, constraints PostgreSQL, índices de expiração/unicidade e relações compostas por workspace foram adicionados;
- repository factory passa a fornecer o boundary de segurança sem expor tabelas ou secrets;
- ADR-024 fixa o protocolo e separa o núcleo testável do futuro transporte de rede.

Regressões e evidências locais:

- suíte unitária passa com 73 testes;
- testes cobrem token/hash, bytes UTF-8 exatos, chave/body/timestamp/versão/event ID adulterados e janela vencida;
- integração Prisma comprova esgotamento, expiração, tentativa incorreta durável, ativação atômica, uso único do challenge e bloqueio do segundo consumo do evento;
- migration v2 passa com 25 tabelas, 88 índices e 55 foreign keys;
- typecheck e geração dos dois clients Prisma passam;
- integração dedicada de webhook passa em SQLite descartável sem alterar a base local.

Limites explícitos desta slice:

- não há chamada HTTPS, DNS pinning, bloqueio de redes privadas/rebinding ou política de redirect; portanto o fluxo não ativa destinos reais ainda;
- o secret provider e a abertura/rotação da chave continuam fora do componente; o verificador recebe bytes somente em memória;
- fan-out do outbox, materialização de deliveries, claim/lease, at-least-once, backoff, dead-letter e replay administrativo continuam abertos;
- a microtarefa permanece aberta até o transporte HTTPS seguro integrar o challenge;
- API/UI administrativa e presenters externos seguros continuam em incremento posterior;
- hosted CI `29372852481` aprovou PostgreSQL, 73 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-036 — Transporte HTTPS seguro do challenge

**Status:** concluído e publicado em 14 de julho de 2026 no commit `e4a816e`.

Entregas:

- o workflow de ativação carrega a URL do endpoint pendente diretamente do repository, emite o token one-shot, transporta a prova e só então executa a ativação atômica;
- DNS é resolvido novamente antes de cada conexão, com no máximo 16 respostas, famílias coerentes e rejeição do conjunto inteiro quando qualquer endereço é inseguro;
- política de rede bloqueia IPv4/IPv6 privados, loopback, link-local, carrier-grade NAT, metadata, multicast, documentação, benchmark, reservados, IPv4-mapped e faixas especiais;
- a conexão HTTPS é presa ao IP público validado por `lookup` próprio, mantendo hostname, Host/SNI e validação normal do certificado;
- cada request usa conexão isolada, TLS mínimo 1.2, porta 443, sem proxy e sem seguir redirects;
- deadline absoluto cobre DNS e HTTPS, configurável entre 1 e 10 segundos, com default de 5 segundos;
- request e response são limitados a 1 KiB; somente status 200, `application/json` e proof JSON canônico com `challengeId` e `token` exatos são aceitos;
- respostas excessivas, malformadas, ambíguas, com content type incorreto, redirect ou ID divergente falham fechadas sem expor o token em resultado ou erro;
- o factory server-side configura o timeout por ambiente e entrega um ativador pronto para futura API/administração;
- ADR-025 formaliza o protocolo de rede, pinning e limites operacionais.

Regressões e evidências locais:

- suíte unitária passa com 79 testes;
- regressões cobrem endereços IPv4/IPv6 públicos e especiais, conjunto DNS misto, ausência de respostas e bloqueio antes da conexão;
- teste de rebinding comprova nova resolução por request e impede a segunda conexão quando o hostname muda de IP público para loopback;
- opções do cliente comprovam IP/família pinados, SNI do hostname, certificado obrigatório, TLS 1.2 e agente não reutilizável;
- deadline absoluto é exercitado contra um adapter que nunca responde e encerra o fluxo dentro do limite configurado;
- respostas com redirect, tipo incorreto, JSON inválido, campos extras, whitespace ambíguo ou challenge divergente são rejeitadas;
- integração Prisma comprova que o target vem do endpoint pendente workspace-scoped;
- typecheck e integração dedicada de webhook em SQLite descartável passam.

Limites explícitos desta slice:

- o ativador existe apenas no boundary server-side; capability, endpoint público e UI administrativa serão entregues no incremento administrativo previsto;
- secret provider, abertura/rotação da chave e assinatura do dispatcher continuam ligados à futura execução de deliveries, não ao challenge;
- fan-out do outbox, materialização de deliveries, claim/lease, at-least-once, backoff, dead-letter e replay administrativo continuam abertos;
- a política fail-closed pode recusar faixas especiais que sejam tecnicamente roteáveis; exceções exigirão revisão explícita, nunca allowlist implícita;
- hosted CI `29374221527` aprovou PostgreSQL, 79 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-037 — Fan-out durável do outbox para deliveries

**Status:** concluído e publicado em 14 de julho de 2026 no commit `45ad714`.

Entregas:

- materializador server-side processa o próximo evento pendente de um workspace por vez, impedindo que corrupção ou excesso de um tenant bloqueie a fila global;
- seleção é determinística por `occurredAt` e event ID, com índice composto por workspace, estado de publicação e ordem;
- somente endpoint e subscription atualmente ativos, criados/verificados antes do evento, podem receber delivery;
- filtros são reidratados e revalidados pelo catálogo; hash, tipos e resource IDs precisam coincidir exatamente com o conteúdo persistido;
- o próprio envelope do outbox é reidratado pelo domínio antes do match, impedindo publicação silenciosa de tipo, versão, recurso ou payload corrompidos;
- cada subscription compatível recebe uma delivery `pending`, com retry policy limitada e `nextAttemptAt` igual ao instante de materialização;
- unicidade `(subscriptionId, eventId)` e `upsert` tornam recuperação/reexecução deduplicada mesmo quando a marca de publicação precisa ser refeita;
- deliveries e `publishedAt` são gravados na mesma transação; falha de ID, filtro, limite ou persistência reverte tudo e mantém o evento pendente;
- evento sem destino elegível também é marcado como publicado, registrando que o roteamento foi concluído sem inventar uma delivery;
- fan-out é limitado a 10.000 subscriptions ativas por evento e falha fechado acima disso;
- factory server-side fornece o materializador, mas nenhuma tabela interna foi exposta pela API.

Regressões e evidências locais:

- suíte unitária passa com 81 testes;
- regressões de domínio cobrem tipo exato, resource ID exato, ausência de resource filter, retry policy e workspace inválido;
- integração Prisma cobre evento anterior à verificação, evento compatível, resource divergente, ausência de destino e ordem determinística;
- recuperação com `publishedAt` removido reutiliza a delivery existente e não duplica `(subscription,event)`;
- filtro adulterado produz `PERSISTENCE_CONFLICT`, não publica o evento e não deixa delivery parcial;
- workspace diferente retorna idle mesmo quando outro tenant possui evento corrompido pendente;
- migration v2 passa com 25 tabelas, 89 índices e 55 foreign keys;
- typecheck, geração dos clients Prisma e integração dedicada em SQLite descartável passam.

Limites explícitos desta slice:

- `publishedAt` significa que o fan-out durável terminou, não que o endpoint recebeu ou confirmou o evento;
- subscriptions ativadas depois de `occurredAt` não recebem backlog automaticamente; replay histórico exigirá comando explícito posterior;
- endpoint/subscription pausado, suspenso ou revogado no instante do fan-out não recebe nova delivery;
- ainda não há claim/lease da delivery, abertura do secret, assinatura do request, chamada HTTPS, classificação de resposta, retry, dead-letter ou replay administrativo;
- o dispatcher futuro deverá reutilizar a resolução DNS pinada do ADR-025 em toda tentativa, não apenas no challenge;
- API/UI administrativa e presenters externos seguros continuam em incremento posterior;
- hosted CI `29375882908` aprovou PostgreSQL, 81 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-038 — Claim, lease e fencing de deliveries de webhook

**Status:** concluído e publicado em 14 de julho de 2026 no commit `75ba853`.

Entregas:

- claim workspace-scoped seleciona apenas delivery pronta e com endpoint/subscription ativos;
- token de lease usa 256 bits e é entregue ao worker uma única vez; somente seu SHA-256 é persistido;
- cada posse cria um attempt numerado e durável na mesma transação que move a delivery para `in-flight`;
- heartbeat exige o fence completo e renova apenas lease válido;
- reclaim fecha attempt expirado com `lease_expired`, cria nova tentativa e impede conclusão pelo worker antigo;
- falha pode agendar retry futuro quando ainda há orçamento; sem retry válido ou ao esgotar tentativas, a delivery vai para dead-letter;
- sucesso exige resposta 2xx, encerra o attempt e remove todo material de lease da delivery;
- constraints PostgreSQL alinham estados, contagens, lease e cronologia dos attempts ao domínio;
- factory server-side fornece claim, heartbeat e settlement, sem expor tabelas internas nem token persistido;
- ADR-027 registra posse one-shot, fencing e política de recuperação.

Regressões e evidências locais:

- suíte unitária de webhook passa com 14 testes e cobre token/hash, lifecycle inválido e cronologia impossível;
- integração Prisma cobre claim, token incorreto, heartbeat, expiração, reclaim, worker obsoleto, retry futuro, sucesso e dead-letter por esgotamento;
- histórico mantém três attempts independentes no fluxo expiração → retry → sucesso;
- migration v2 passa com 25 tabelas, 90 índices e 55 foreign keys;
- typecheck, geração dos dois clients Prisma e integração dedicada em SQLite passam.

Limites explícitos desta slice:

- ainda não há abertura do secret, assinatura do request ou chamada HTTPS da delivery;
- classificação automática de respostas, backoff com jitter e limites por destino entram no dispatcher posterior;
- replay administrativo, capability/API/UI de inspeção e rotação do secret continuam abertos;
- o transporte de delivery deverá reutilizar DNS pinning, TLS e limites do ADR-025 em cada tentativa;
- hosted CI `29377540450` aprovou PostgreSQL, 82 testes, contratos, API, FFmpeg, Remotion real, build e auditorias após o hotfix de cleanup `7cfe9bc`.

### Slice F0-039 — Dispatcher assinado de webhook deliveries

**Status:** concluído e publicado em 14 de julho de 2026 no commit `2012560`.

Entregas:

- dispatcher só carrega o target quando workspace, delivery, owner, attempt, hash do token e lease válido coincidem;
- evento é reidratado do outbox e serializado em JSON canônico, usando exatamente os mesmos bytes na assinatura e no request;
- target exige endpoint/subscription ativos e exatamente um secret ativo, retornando apenas referência, versão e fingerprint;
- boundary de secret provider é injetável e não possui fallback inseguro; a chave é aberta somente em memória, verificada por fingerprint e a cópia local é zerada no `finally`;
- fingerprint divergente termina sem conexão; indisponibilidade do provider é classificada como transitória;
- transporte assinado resolve DNS em toda tentativa, rejeita endereços especiais, prende HTTPS ao IP validado e preserva Host/SNI/certificado;
- TLS mínimo 1.2, porta 443, ausência de redirect/reuso, deadline absoluto e limites de 256 KiB no request e 64 KiB na resposta são aplicados;
- resposta bruta não atravessa o boundary: somente status HTTP e SHA-256 do body seguem para settlement;
- 2xx conclui sucesso; 408, 425, 429 e 5xx usam retry; demais respostas não-2xx são terminais;
- backoff exponencial limitado recebe jitter determinístico por delivery+attempt;
- resultado da rede ainda precisa vencer o fence no settlement, impedindo worker stale de concluir;
- ADR-028 formaliza reconstrução canônica, abertura do secret, assinatura, rede e classificação.

Regressões e evidências locais:

- suíte global passa com 86 testes; 18 são contratos de webhook;
- transporte prova bytes e headers exatos, IP pinado, event ID coerente e bloqueio de DNS privado antes da conexão;
- dispatcher prova assinatura verificável, ausência de token bruto na persistência, fingerprint mismatch sem rede, retry de falha transitória e backoff futuro;
- integração Prisma executa outbox canônico → abertura da chave → assinatura → resposta 204 → settlement bem-sucedido;
- build, typecheck, contratos públicos, migration, auditorias e todas as integrações SQLite passam;
- a regressão de cleanup de mídia descoberta no CI foi corrigida no commit `7cfe9bc` e passou cinco execuções locais consecutivas e o hosted CI `29377540450`.

Limites explícitos desta slice:

- o adapter concreto do secret provider por ambiente ainda precisa ser escolhido e configurado;
- ainda não existe loop executável que una claim, heartbeat e dispatch continuamente;
- replay administrativo, rotação operacional, rate limit/circuit breaker por endpoint e observabilidade continuam abertos;
- API/UI administrativa de endpoint, delivery e attempts permanece no incremento previsto;
- hosted CI `29378737291` aprovou PostgreSQL, 86 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-040 — Runner e loop do worker de webhook deliveries

**Status:** concluído e publicado em 14 de julho de 2026 no commit `f2a2e86`.

Entregas:

- runner une claim, heartbeat, dispatch e settlement em uma única unidade workspace-scoped;
- claim ocioso retorna sem criar timer, abrir secret ou executar transporte;
- heartbeat não sobrepõe renovações e permanece ativo durante abertura da chave, DNS e HTTPS;
- factory valida heartbeat menor que lease e constrói runner completo com repository, transporte e provider injetado;
- settlement fenced continua sendo a autoridade final: `stale` vira `lease-lost`, enquanto sucesso persistido não é rebaixado por heartbeat tardio;
- outcomes expõem apenas workspace, delivery, attempt e status, sem token, URL, chave, payload, assinatura ou resposta;
- loop recebe shard explícito de 1 a 1.000 workspaces únicos e processa uma delivery por tenant a cada passagem;
- round-robin impede starvation por workspace com backlog elevado;
- falha de um tenant é isolada e reportada apenas com workspace ID, sem interromper os demais;
- polling ocorre somente quando todo o shard está ocioso e pode ser interrompido por `AbortSignal`;
- desligamento gracioso impede novos claims e deixa a iteração corrente concluir;
- ADR-029 formaliza lifecycle, justiça entre tenants, callbacks seguros e pré-requisitos do host.

Regressões e evidências locais:

- suíte global passa com 89 testes; 21 são contratos de webhook;
- runner longo comprova heartbeat durante dispatch e ausência de renovação sobreposta;
- perda do heartbeat com settlement stale retorna `lease-lost`;
- loop comprova isolamento de erro, passagem para o próximo workspace e parada graciosa;
- callbacks foram verificados sem token ou chave;
- integração Prisma agora executa retry due → claim → dispatcher assinado → settlement através do runner;
- typecheck e integração dedicada de webhook em SQLite passam.

Limites explícitos desta slice:

- o host ainda precisa fornecer provider de secrets;
- discovery dinâmica e sharding determinístico entram na F0-041; coordenação de rebalanceamento e autoscaling permanecem posteriores;
- ainda não existe entrypoint de produção porque a escolha do secret provider não foi tomada;
- replay administrativo, rotação operacional, rate limit/circuit breaker e observabilidade continuam abertos;
- hosted CI `29379751447` aprovou PostgreSQL, 89 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-041 — Discovery paginada e sharding do worker de webhooks

**Status:** publicado em 14 de julho de 2026 no commit `03b9d4b`, com correção de compatibilidade PostgreSQL no commit `996d96f`.

Entregas:

- discovery encontra automaticamente workspaces ativos com delivery vencida, retry devido ou lease expirado, exigindo também subscription e endpoint ativos;
- cursor v1 preserva `asOf` entre páginas, usa high-water por workspace ID e é vinculado às coordenadas do shard;
- workspaces e deliveries criados depois de `asOf` são adiados para o próximo ciclo, evitando deriva por inserção durante a paginação;
- shard usa SHA-256 estável do workspace ID e independe da posição da página;
- validações rejeitam cursor adulterado ou de outro shard, páginas desordenadas, IDs inválidos e limites fora da faixa;
- scheduler percorre todas as páginas, executa no máximo uma delivery por workspace e ignora duplicatas entre páginas;
- cursor repetido e falha de discovery encerram somente o ciclo atual, com callbacks de observabilidade que não controlam a execução;
- factory entrega `discover` e `runNext` já compostos sobre o mesmo boundary de persistência;
- dois índices compostos sustentam discovery por workspace, status, vencimento/lease e ID;
- ADR-030 formaliza corte temporal, paginação, hash de shard e segurança durante redistribuição.

Regressões e evidências locais:

- suíte global passa com 91 testes; 23 são contratos de webhook;
- contrato comprova `asOf` único, paginação completa, união determinística do shard e rejeição de cursor incompatível;
- loop comprova travessia de páginas, deduplicação de workspace e parada graciosa após a unidade corrente;
- integração Prisma comprova que retry futuro fica invisível e aparece exatamente ao vencer, seguindo até dispatch e settlement;
- typecheck, 91 testes globais, contratos públicos, migrations, build e auditorias passam;
- integrações SQLite de artifact, projeto, operação, webhook e API passam, assim como FFmpeg, bundle e render real do Remotion;
- migration validada com 25 tabelas, 92 índices e 55 chaves estrangeiras.

Limites explícitos desta slice:

- a atribuição de `shardIndex/shardCount` ao processo ainda pertence ao deployment; coordenação dinâmica de ownership e autoscaling não foi implementada;
- o adapter concreto do secret provider e o entrypoint de produção continuam pendentes;
- mudanças concorrentes de status não formam snapshot transacional; claim e fencing permanecem a autoridade contra execução duplicada;
- replay administrativo, rotação operacional, rate limit/circuit breaker e observabilidade continuam abertos;
- o primeiro hosted CI (`29380970328`) detectou que uma fixture alterava `createdAt` além de `nextAttemptAt`, violando corretamente o constraint PostgreSQL; a fixture inválida foi removida em `996d96f` sem alterar código de produção;
- hosted CI corrigido `29381478867` aprovou PostgreSQL, 91 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-042 — API administrativa de webhook delivery diagnostics

**Status:** concluído e publicado em 14 de julho de 2026 no commit `12ca917`.

Entregas:

- capability `apollo.webhooks.deliveries.list` expõe listagem workspace-scoped com scope `webhooks:admin`;
- filtros allowlisted cobrem status, endpoint e evento, além de limite e cursor opaco;
- cursor v1 vincula workspace e todos os filtros por SHA-256, impedindo reaproveitamento ambíguo;
- capability `apollo.webhooks.deliveries.read` expõe uma delivery e seus attempts em ordem crescente;
- leitura cross-workspace é indistinguível de inexistente;
- presenters excluem workspace, URL, payload, assinatura, headers, lease, heartbeat, secret e corpo de resposta;
- diagnóstico mantém apenas status HTTP, hash do body e error code redigido para correlação;
- JSON Schemas, exemplos, capability discovery, OpenAPI e duas rotas Next usam o mesmo contrato versionado;
- três índices compostos sustentam listagem geral, filtro por evento e percurso por subscription;
- ADR-031 formaliza escopo administrativo, paginação, redaction e fronteira com replay futuro.

Regressões e evidências locais:

- suíte global passa com 93 testes; 25 são contratos de webhook;
- contratos cobrem paginação, cursor vinculado a filtros, leitura workspace-scoped e attempts ordenados;
- integração Prisma cobre status+endpoint+evento, cross-workspace e histórico dead-letter;
- jornada HTTP autenticada cobre discovery/OpenAPI, list/read, resposta redigida, filtro inválido e 403 sem scope;
- contratos públicos passam com 29 capabilities, 35 schemas, 43 exemplos e 26 paths;
- build registra `/v1/webhooks/deliveries` e `/v1/webhooks/deliveries/{deliveryId}`.
- migration passa com 25 tabelas, 95 índices e 55 chaves estrangeiras;
- auditorias sem vulnerabilidades, FFmpeg, todas as integrações SQLite, bundle e render real do Remotion passam.

Limites explícitos desta slice:

- não há mutação administrativa, replay, rotação de secret ou administração de endpoint/subscription;
- UI administrativa ainda não foi iniciada;
- retenção e purge de attempts permanecem para política operacional posterior;
- rate limit, quotas, circuit breaker e métricas continuam abertos;
- hosted CI `29381735068` aprovou PostgreSQL, 93 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-043 — Replay administrativo controlado de webhook delivery

**Status:** publicado em 14 de julho de 2026 no commit `b2ae5ce`; hosted CI `29382555167` aprovado.

Entregas:

- capability `apollo.webhooks.deliveries.replay` expõe replay individual sob `webhooks:admin` e confirmação humana;
- `Idempotency-Key` é obrigatório e o fingerprint vincula ação, workspace, cliente e delivery;
- ledger e transição da delivery são persistidos na mesma transação;
- primeira aceitação retorna 202 e repetição idempotente devolve o snapshot original com 200;
- mesma chave com outro alvo falha por payload mismatch;
- apenas `succeeded` e `dead-lettered` podem ser reabertas, exigindo endpoint e subscription ativos;
- attempts anteriores são preservados e a próxima tentativa continua sendo criada pelo claim normal do worker;
- replay limpa terminal/lease, agenda retry e concede uma tentativa adicional somente quando o teto anterior foi consumido;
- limite absoluto de 20 attempts não pode ser ampliado;
- CAS por status+`updatedAt` impede replays concorrentes de agendarem duas execuções;
- presenter reutiliza o diagnóstico redigido, sem URL, payload, assinatura, secret, lease ou body;
- ADR-032 formaliza idempotência, estados aceitos, tentativa adicional e composição futura em lote.

Regressões e evidências locais:

- suíte global passa com 95 testes; 27 são contratos de webhook;
- domínio cobre estado terminal, limpeza de terminal e teto absoluto;
- service contract cobre chave obrigatória, fingerprint, TTL e agenda canônica;
- integração Prisma cobre target inativo, replay dead-letter, aumento único do teto, snapshot idempotente, mismatch de alvo e segunda chave rejeitada;
- jornada HTTP cobre OpenAPI, 422 sem chave, 202 inicial, 200 idempotente, 409 para segundo replay e 403 sem scope;
- contratos públicos passam com 30 capabilities, 36 schemas, 45 exemplos e 27 paths;
- build registra `/v1/webhooks/deliveries/{deliveryId}/replay`.
- migration permanece válida com 25 tabelas, 95 índices e 55 chaves estrangeiras;
- auditorias sem vulnerabilidades, FFmpeg, todas as integrações SQLite, bundle e render real do Remotion passam.

Limites explícitos desta slice:

- replay por event ID, intervalo ou lote ainda não foi implementado;
- não há cancelamento de replay já aceito além das regras normais do worker;
- rotação de secret, mutações de endpoint/subscription e UI continuam abertas;
- política de retenção/purge do ledger e attempts permanece operacional;
- hosted CI `29382555167` aprovou PostgreSQL, 95 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

### Slice F0-044 — Replay administrativo por evento exato

**Status:** publicado em 15 de julho de 2026 no commit `ab85061`; hosted CI `29407811656` aprovado.

Entregas:

- capability `apollo.webhooks.events.replay` expõe replay de um event ID exato sob `webhooks:admin`, confirmação humana e custo alto;
- `Idempotency-Key` é obrigatório e vincula ação, workspace, API client, evento e limite do lote;
- uma chamada avalia no máximo 100 deliveries, em ordem determinística por ID;
- resultado classifica cada item como `scheduled`, `skipped-non-terminal`, `skipped-target-inactive` ou `skipped-attempt-limit`;
- somente itens terminais, abaixo de 20 attempts e com endpoint/subscription ativos são reagendados;
- a transição canônica preserva attempts, limpa terminal/lease e amplia `maxAttempts` somente se necessário;
- todo o lote, os CAS por status+`updatedAt` e o ledger idempotente são atômicos;
- evento sem item elegível retorna conflito sem ledger; evento fora do workspace retorna 404;
- primeira aceitação retorna 202 e repetição da mesma chave retorna o snapshot redigido original com 200;
- mesma chave com outro evento retorna payload mismatch;
- ADR-033 formaliza o limite, as classificações, atomicidade e a fronteira para futuro replay por intervalo.

Regressões e evidências locais:

- suíte global passa com 96 testes; 28 são contratos de webhook;
- service contract cobre chave obrigatória, fingerprint, TTL, agenda e lote limitado a 100;
- integração Prisma cobre reagendamento, attempts preservados, snapshot idempotente, mismatch, ausência de elegíveis e 404;
- jornada HTTP cobre OpenAPI, 422 sem chave, 202 inicial, 200 idempotente, 409 sem elegíveis, redaction e 403 sem scope;
- contratos públicos passam com 31 capabilities, 37 schemas, 47 exemplos e 28 paths;
- build registra `/v1/webhooks/events/{eventId}/replay`;
- hosted CI `29407811656` aprovou PostgreSQL, 96 testes, contratos, API, FFmpeg, Remotion real, build e auditorias.

Limites explícitos desta slice:

- replay por intervalo, filtro ou lote arbitrário ainda não foi implementado;
- lotes acima de 100 exigirão preflight, operação durável e resultado paginado;
- não há cancelamento específico após a aceitação além das regras normais do worker;
- rotação de secret, mutações de endpoint/subscription e UI continuam abertas;
- política de retenção/purge do ledger e attempts permanece operacional.

### Slice F0-045 — Secret provider e entrypoint operacional de webhook

**Status:** concluído localmente em 15 de julho de 2026; ainda não commitado.

Entregas:

- adapter concreto lê um catálogo protegido de signing secrets do ambiente sem persistir material no banco;
- cada secret é vinculado exatamente a workspace, endpoint, referência opaca e versão;
- boot falha fechado para configuração ausente, malformada, duplicada, grande demais ou com secret fora de 32–512 bytes;
- catálogo aceita no máximo 1.000 entradas e 256 KiB, sem campos desconhecidos;
- mensagens de erro não incluem configuração, referência ou bytes sensíveis;
- cada abertura entrega bytes novos; temporários do adapter e o array devolvido ao dispatcher são zerados;
- fingerprint persistido continua sendo verificado antes da rede;
- factory expõe construção configurada sem fallback inseguro;
- `worker:v2:webhook` inicia discovery e runner com lease owner único, sharding limitado e encerramento gracioso;
- ADR-034 formaliza binding, redaction, lifecycle dos bytes e fronteira com providers externos/rotação futura.

Regressões e evidências locais:

- suíte global passa com 98 testes; 30 são contratos de webhook;
- contratos cobrem binding exato, cópias independentes, request divergente e configurações ambíguas sem disclosure;
- contrato do dispatcher confirma descarte do array aberto pelo provider;
- integração Prisma executa assinatura e settlement usando o adapter concreto;
- entrypoint passa por verificação sintática e permanece interno: nenhuma capability externa pode ler material secreto;
- contratos públicos permanecem compatíveis com 31 capabilities, 37 schemas, 47 exemplos e 28 paths;
- migration permanece válida com 25 tabelas, 95 índices e 55 chaves estrangeiras;
- todas as integrações SQLite, build, FFmpeg, Remotion real, bundle e auditorias sem vulnerabilidades passam.

Limites explícitos desta slice:

- rotação administrativa, reload dinâmico e integração nativa com vault/KMS continuam abertos;
- o catálogo protegido é apropriado para a primeira operação, mas deployments maiores deverão usar outro adapter da mesma porta;
- rebalanceamento coordenado entre shards e replay por intervalo continuam abertos;
- métricas, circuit breaker, rate limits e UI operacional permanecem futuras.
