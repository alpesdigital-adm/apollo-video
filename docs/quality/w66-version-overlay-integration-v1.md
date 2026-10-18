# W66 — decisão proposta de estado de output selado por ProjectVersion

**Estado em 11/10/2026:** direção revisada para preparar schema e contratos, condicionada à revisão do diff efetivo e ao cutover integral descrito abaixo. Schema, migration, contratos públicos e runtime ainda não estão implementados por este documento. Não há validação PostgreSQL, aceite visual ou entrega da W66. O registro canônico permanece em project-status.json/PROJECT-STATUS.md, sob responsabilidade do owner da integração.

**Escopo:** F1.031 eba5d6a20bbd-1, 0293bff3321f-1, 4d9bedfd87ea-1, da5a414c29b3-1, 72babc1df6c4-1; handoff para W65/W67/W68. Crop manual é preferência editorial com provenance de Command. Não comprova rosto seguro nem libera reframe automático, que depende de percepção verificada e crítica visual.

## 1. Fatos conferidos no código

| Ponto atual | Evidência no repositório | Lacuna para W66 |
| --- | --- | --- |
| Identidade do override é formato | src/v2/domain/variant-reframe-overrides.ts: VariantReframeOverrideV1.variantId é OutputAspectRatio; clips ordenados por ID | Duas variantes 9:16 colidem; sourceMapHash não conserva ordem de reprodução. |
| OutputSpec é valor de domínio | src/v2/domain/output-spec.ts; prisma/v2/schema.prisma | Não há registro persistente de variante/revisão ligado à versão. Preset não é variante. |
| ProjectVersion valida/congela referências | src/v2/domain/project-version.ts; src/v2/application/version-hash.ts | Não sela outputs/overlays. Producers calculam hashes específicos, sem commit comum. |
| Proxy resolve formato administrativo | src/v2/infrastructure/prisma/project-proxy-render-repository.ts, hydrateSource: project.format com default 9:16 | Formato de uma versão pode vir de fora de seu estado. |
| Fonte secundária escolhe manifest da consulta | Mesmo repositório, hydrateSource e readRenderableSnapshotSource: artifact.manifests[0] | Manifest exato de cada clip precisa ser selado; consulta posterior não escolhe outro. |
| Worker mistura identidade/formato | src/v2/application/run-project-proxy-render-worker.ts: compara reframePlan.variantId a source.format | Validar identidade, revisão e aspect ratio separadamente. |
| Reframe consulta registry atual | src/v2/domain/render-reframe-plan.ts: readOutputFormatPreset na criação/validação | Mudança de preset não pode alterar output histórico; revisão materializada será autoridade. |
| Final reconstrói identidade/safe area | src/v2/application/run-project-final-export-worker.ts: ID final derivado do aspectRatio, insets 0,05 | Final consome identidade/revisão seladas e passa sua própria prova visual. |
| Writers distribuídos | 15 chamadas de createProjectVersion na aplicação; 16 repositórios com v2ProjectVersion.create | Cada caminho precisa transição; anexo de biblioteca é o writer direto extra. |

Esses são fatos de leitura local, não comprovação da implantação. Este desenho substitui a proposta anterior de um estado exclusivo de crop: uma única autoridade sela também as revisões selecionadas dos outputs.

## 2. Modelo escolhido para revisão

### OutputVariant e OutputSpecRevision

OutputVariant tem ID estável, pertence a exatamente (workspaceId, projectId) e não representa formato, preset, índice de lista, filename nem hash do OutputSpec. Duas variantes distintas podem ter specs iguais e mesmo aspecto. Sua identidade sobrevive aos Commands e revisões.

OutputSpecRevision é append-only, identifica (workspaceId, projectId, variantId, revisionId), conserva revisionNumber, Command de origem, documento OutputSpec e specHash. Materializa locale, aspectRatio, width/height/fps, safeArea e deliveryProfileId. Se usar preset, grava seu documento/hash/version. Toda dependência que afeta pixels ou encoding é materializada e selada: definição/revisão do perfil, codec, container, qualidade, áudio e legendas quando aplicáveis. Alterar valores cria revisão nova; não há UPDATE nem lookup do registry atual no render.

Uma projeção administrativa pode mostrar o output selecionado no estado corrente; nenhum currentOutputSpec/maior revisionNumber é autoridade de render.

### ProjectOutputState único

Cada ProjectVersion nova possui exatamente um ProjectOutputState imutável com schemaVersion project-output-state/v1. Versão sem outputs grava entries vazio explicitamente; ausência não significa vazio.

Uma variante pode existir antes do ingest, com geometria explicitamente unmaterialized e nenhuma fonte de vídeo referenciada. Nesse estado não há crop ativo nem render autorizado. Quando o plano passa a referenciar vídeo, geometria verified exige os metadados observados completos; fonte referenciada sem probe não pode ser convertida em unmaterialized para contornar o gate.

Corpo canônico:

- id, workspaceId, projectId, resultVersionId pré-alocado, parentVersionId/parentStateHash quando houver, Command/provenance e versão da política de transição;
- editPlanSnapshotId/editPlanHash e, se outro plano for efetivamente renderizado, binding explícito para RenderablePlanSnapshot com planId/planHash e projeção correspondente;
- entradas ordenadas por variantId; cada entrada seleciona uma revisão exata outputSpecRevisionId/specHash, documento materializado e geometryProjectionHash;
- overlays tipados por variante/clip/range, documento/hash e Commands originais, estado active ou invalidated;
- invalidations/issues por variante/range, hashes/revisões antigos e novos, motivo, Command causador e referência ao conteúdo desativado;
- fontes/manifests/probes e mapa geométrico selados suficientes para reconstruir o input.

stateHash é hash do corpo sem seu próprio hash. Não entram resultBaseHash, hash final da ProjectVersion ou artifact futuro. Documento, linhas auxiliares, overlays e issues formam um agregado atômico. Linhas normalizadas são índices/integridade desse mesmo estado; divergência com JSON/hash é erro, nunca preferência do leitor.

Duas entradas irmãs podem ter outputFormat 9:16 e mesmo conteúdo de spec, mas têm variantId e revisionId distintos. Overrides, invalidations, artifacts, reports e reuso referenciam a entrada exata. Alteração de A muda stateHash total; não invalida automaticamente crop/artifact de B. Reuso de B exige igualdade de suas próprias dependências e lineage explícito na versão nova, nunca igualdade de formato.

### Commands e baseline explícito

Propor create-output-variant e revise-output-spec como Commands públicos, além do override por variante. Rotas /v1, schemas e capability IDs devem passar revisão e registro antes do runtime; o endpoint público de Commands pode expô-los. UI e automação usam o mesmo application service.

create-output-variant recebe baseVersionId/baseHash, idempotency key e OutputSpec completo ou preset escolhido explicitamente. Cria identidade, primeira revisão e estado do filho atomicamente. Criação de projeto pode solicitar esse efeito explicitamente em seu contrato público/audit; sem solicitação, raiz tem estado vazio. **Nunca criar primeira variante, inferir canvas ou preencher revisão a partir de project.format/default ao ler, renderizar ou migrar.**

Projeto histórico sem estado exige Command explícito de inicialização/criação de output para produzir filho selado. Serviço valida base/manifests/metadados observados; não reescreve versões antigas. Crop v1 por formato não é convertido por adivinhação: novo Command declara variante real/range. Documentos históricos permanecem legíveis para auditoria; parser histórico não alimenta o render novo.

## 3. Hashes, FKs e commit sem ciclo

Nomes de tabelas são propostas, não schema existente.

| Relação | Constraint proposta | Garantia |
| --- | --- | --- |
| V2OutputVariant → Project | FK (projectId, workspaceId); unique (id, projectId, workspaceId) | Variante não atravessa escopo. |
| V2OutputSpecRevision → Variant | FK (variantId, projectId, workspaceId); unique (variantId, revisionNumber, projectId, workspaceId) e (id, variantId, projectId, workspaceId, specHash) | Revisão pertence à identidade certa; hash vinculável. |
| V2ProjectOutputState → Project/base | FK de projeto; FK opcional parentVersion escopada; unique (id, projectId, workspaceId), (resultVersionId, projectId, workspaceId) e (resultVersionId, id, projectId, workspaceId, stateHash) | No máximo um estado para resultVersionId. Sem FK reversa à versão resultado. |
| Version → State | FK (id, outputStateId, projectId, workspaceId, outputStateHash) → State (resultVersionId, id, projectId, workspaceId, stateHash) | Outra versão, mesmo do projeto, não usa esse estado; hash/escopo devem coincidir. |
| StateEntry → State/Revision | FK (stateId, projectId, workspaceId) do estado; FK (outputSpecRevisionId, variantId, projectId, workspaceId, specHash); unique (stateId, variantId) e (stateId, variantId, projectId, workspaceId) | Uma revisão por variante na versão; revisão não troca de irmã; chave composta referenciável pelos overlays. |
| Overlay/Invalidation → Entry | FK (stateId, variantId, projectId, workspaceId); referências de Command/hash conforme contrato | Overlay não existe sem membership. Referência externa histórica é lineage, não membership. |

Dependências imutáveis usam RESTRICT. Estados isolados não são publicáveis: leitura parte do FK de versão existente, nunca de resultVersionId isolado. Repositório sempre grava State+Version juntos. Proibir absolutamente órfãos ao COMMIT SQL pode usar constraint trigger deferred testado; não cria FK circular. Confirmar geração Prisma e índices compostos na revisão de schema.

Ordem na transação serializável:

1. Resolver replay/fingerprint, autenticação/workspace e autorização. Replay não recalcula crop, IDs nem datas. Rights atuais ainda podem bloquear novo uso/render de Command histórico.
2. Ler base exata/state/revisions/fontes; conferir hashes e CAS da mutação. Ausência/contradição aborta, exceto baseline histórico público explícito descrito acima.
3. Pré-alocar Command/resultVersionId/stateId/revisionIds; construir snapshot e transição pura. IDs e relógio ficam fora do fingerprint da requisição.
4. Calcular producerHash pelo payload de versão de cada producer com schema declarado; stateHash = H(stateBody); baseHash = H({ schemaVersion: project-version-output-state/v1, workspaceId, projectId, resultVersionId, parentVersionId, previousBaseHash, producerHash, outputStateId, outputStateHash: stateHash }). Raiz usa parent/previous explicitamente nulos. State não contém baseHash nem valor dependente dele.
5. Gravar Command/snapshots/revisões; State/entries/overlays/issues; Version já com FK/hash definitivos. Raiz cria Project antes de State; criação conserva audit próprio existente. Nenhuma Version provisória, FK nula temporária ou UPDATE posterior.
6. CAS currentVersionId, invalidation records/outbox/audit no mesmo commit. Falha faz rollback integral, inclusive identidades/revisões novas.

Fingerprint canônico versionado inclui workspace/project, baseVersionId/baseHash, ator/contexto autenticado, tipo, variantId/revisão esperada quando existentes, payload do spec/overlay, clip/range e razão relevante. Não inclui IDs gerados, createdAt ou mutable consultado depois. Mesma chave com payload/ator/irmã/revisão diferente gera IDEMPOTENCY_PAYLOAD_MISMATCH; base concorrente gera VERSION_CONFLICT. Writer revalida proposta da aplicação contra fatos locked; não aceita apenas hash do caller.

## 4. Projeção geométrica versionada

variant-reframe-geometry/v1 é distinta do EditPlan completo/state inteiro. Igualdade decide validade geométrica de crop, não reuso geral de render nem aprovação facial.

| Grupo | Conteúdo canônico | Regra |
| --- | --- | --- |
| Output | variantId, aspectRatio, width/height, output fps e transformação de proxy→final versionada | Revisão completa fica selada; safe area invalida placement/critic conforme suas dependências. |
| Timeline | fps/timebase, durationFrames, track base-video selecionado | Worker atual usa primeiro track desse kind; seleção ambígua/múltiplos tracks não suportados bloqueia. |
| Clips | Array na ordem real de render: id, sourceArtifactId, sourceManifestId/hash, SHA-256 dos bytes, sourceIn/OutFrame, timelineIn/OutFrame, rate | Não ordenar por clip ID; troca de ordem muda projeção. Não escolher manifest mais recente. |
| Probe de cada vídeo | width/height, fps/timebase observados, orientação/display transform, versão/hash de probe e normalização | Conferir SHA/manifest/probe com bytes materializados; ausência não vira orientação zero nem fps da timeline. |
| Composição | Presença explícita e valor de foregroundScale/verticalPosition | Distinguir ausente de presente; defaults atuais 1 e 0,5 não autorizam equivalência sem policy versionada. |
| Crop global | Presença de clip.crop no plano efetivo | Caminho novo rejeita crop global concorrente; corrigir por Command, sem convertê-lo por formato. |

Fontes: run-project-proxy-render-worker.ts, ports/editorial-proxy-renderer.ts e infrastructure/media/ffmpeg-editorial-proxy-renderer.ts. Adapter busca por sourceInFrame/fps, recorta spans, aplica rate, concatena em ordem e compõe vídeo. Reframe atual exige ranges contíguos, um por clip, mesma dimensão de fonte e tamanho de crop constante. Limites continuam explícitos até novo contrato testado.

audioSource*, música, texto/cues, estilo da legenda, CTA textual, LUT e ColorPlan **não entram na projeção de crop**. Hoje transitions nesse renderer aplica fades de áudio; não transforma seam visual. layout/background não são controles desse port e não entram por suposição. Esses dados continuam selados em seus contratos e entram no hash de RenderInput/recipe: exclusão da projeção de crop não autoriza reutilizar pixels após alterá-los.

Novo campo que transforme vídeo, overlay visual que altere região disponível ou renderer diferente exige projeção/impact policy nova antes da herança. Placement/legenda têm dependências próprias de safe area, cue/range, obstáculos e percepção, tratadas por kind no mesmo estado. Projeção de crop não prova segurança facial.

FPS fonte/timeline, rate e orientação exigem conversão explícita implementada/testada. Override v1 atual exige rate=1, spans iguais e source fps=timeline fps. Fonte 24 fps em timeline 30 fps não passa por preencher ambos com 30. Metadado ausente/contraditório bloqueia herança/materialização; não gerar estado ativo.

## 5. Transição explícita de toda versão

Helper de domínio proposto transitionProjectOutputState recebe base exata, planos/fontes/probes/revisões antes/depois, Command/resultVersionId e policy versionada. Retorna agregado selado, nunca undefined. Helper proposto commitProjectVersionWithOutputState recebe Prisma.TransactionClient, revalida fatos locked e grava atomicamente. Gate de arquitetura detecta inserções diretas fora do helper.

| Transição | Condição | Resultado obrigatório |
| --- | --- | --- |
| initialize-empty | Raiz sem output solicitado | Estado vazio; render bloqueado por falta de variante. |
| create-variant | Command explícito, base válida | Nova identidade/revisão/entrada; irmãs copiadas com revisions exatas. |
| revise-output | Command explícito de variante | Nova revisão só dessa entrada; comparar dependências por kind e invalidar afetadas. |
| inherit | Projeção igual e metadados coerentes | Copiar overlays preservando Command original; novo State/hash pertence ao filho. |
| set-overlay/reset-overlay | Variante/clip/range exatos | Substituir range exato; reset auditado. Overlap parcial é conflito sem split automático. |
| invalidate | Fonte/ordem/tempo/geometria ou outra dependência mudou | Preservar conteúdo desativado + issue/reason/old/new hashes. Range desaparecido continua referenciado como anterior. |
| restore | Undo/redo/restore aponta versão alvo explícita | Novo estado a partir do alvo exato, membership válido no mesmo projeto, Command de restore/invalidation. Sem ancestral/latest. |
| fork-empty | Duplicação para outro projeto | Estado vazio com origem explícita; identidades novas só por Command. Não herdar IDs/revisões de outro projeto. |

Crop invalidado mantém review/block e exige resolução/redefinição/reset explícito pela policy; não reaplica set anterior nem promove artifact silenciosamente. Irmã conserva overlay quando suas próprias dependências não mudam. Texto/áudio/cor podem herdar crop, mas invalidam render/critic/sidecar conforme contratos. Safety policy mais restrita pode bloquear export mesmo com crop igual.

### Matriz dos 15 builders e 16 writers PG

Todos os caminhos precisam hidratar/propagar discriminator/stateId/hash/revisão, inclusive replay/eventos/respostas. A tabela especifica integração a fazer; não afirma que exista. Linhas conferidas nesta leitura; alterações posteriores exigem atualizar inventário.

| # | Builder de aplicação | Writer Prisma | Transição obrigatória |
| --- | --- | --- | --- |
| 1 | create-project.ts:218 | project-creation-repository.ts:227 | initialize-empty; output explícito no contrato usa efeito create-variant auditado. Sem project.format. |
| 2 | run-media-ingest-worker.ts:357 | project-media-repository.ts:258 | É versão filha: propagar entries/revisions; comparar geometria após ingest, inherit/invalidate. Pai vazio segue vazio. |
| 3 | duplicate-project.ts:174 | project-duplication-repository.ts:496 | fork-empty com lineage; transferência editorial exige Command e reidentificação explícitos. |
| 4 | manual-edit.ts:311 | manual-edit-repository.ts:544 | Crop novo é set-overlay fora do EditPlan; select/inspect preservam sob projeção igual. Undo/redo/restore: alvo exato. Outras edições comparam/invalidate. |
| 5 | apply-editorial-cut-command.ts:543 | editorial-command-repository.ts:385 | Comparar mapa/tempo/order; corte geralmente invalidate ranges, preservando revisions. |
| 6 | run-project-director.ts:1158 | director-run-repository.ts:977 | Resolver entries da base; comparar plano/fontes e inherit/invalidate. Reframe do Diretor liga à entrada/evidência verificada exatas. |
| 7 | multicam-direction.ts:1414 | multicam-direction-command-repository.ts:465 | Mudança câmera/fonte/mapa compara SHA/probe/order; invalidate afetados. Sem crop da câmera anterior. |
| 8 | replace-source-transcript.ts:144 | source-transcript-replacement-repository.ts:266 | Builder recompila plano: inherit somente sob projeção igual. Texto não garante tempo igual; mapa divergente invalida. |
| 9 | review-patch.ts:286 | review-patch-repository.ts:448 | Patch temporal/geometria compara/invalida; somente texto/cor pode inherit crop sob igualdade comprovada. |
| 10 | review-patch-batch.ts:305 | review-patch-batch-repository.ts:430 | Comparação após composição de todos patches; estado/issues atômicos para lote. |
| 11 | project-policy-overrides.ts:142 | project-policy-overrides-repository.ts:403 | Crop inherit sob igualdade; reavaliar safety/placement se policy mudar. Sem elevar manual a detector. |
| 12 | project-lut-selections.ts:124 | project-lut-selection-repository.ts:425 | Recompila EditPlan: comparar projeção; LUT sozinho permite inherit crop. Render/cor invalidam separadamente. |
| 13 | project-color-plans.ts:217 | project-color-plan-repository.ts:473 | Inherit crop sob projeção igual; invalidar artifacts/critic de cor necessários. |
| 14 | project-subtitle-configurations.ts:57 | project-subtitle-configuration-repository.ts:131 | Resolver variante real/revisão; inherit crop sob igualdade; alterar cues/placement/invalidations só do escopo afetado. |
| 15 | subtitle-segment-overrides.ts:176 | subtitle-segment-override-repository.ts:327 | Igual à anterior; conservar Command/range original e reset explícito; texto/estilo não altera crop da irmã. |
| 16 | Sem builder createProjectVersion; MediaLibraryRepository.attach | media-library-repository.ts:309 | Helper obrigatório. Anexo preserva EditPlan: inherit sob igualdade. Inserção posterior no vídeo por outro Command compara/invalida. |

Futuros writers create-output-variant/revise-output-spec entram no inventário e gate. Writer que omite transição falha antes do commit; estado vazio também é propagado explicitamente. Corrigir apenas writer de crop é insuficiente.

## 6. Leitura/render e handoff W65–W69

| Consumidor | Cutover necessário |
| --- | --- |
| Detail/compare/restore/replay de Version | Expor estado/revisions exatos; distinguir histórico não selado, vazio e invalidated; não omitir hashes. |
| enqueue-project-proxy-render.ts, port/repositório | Selecionar variant/revision na versão solicitada; selar state/entry hashes no contexto/fingerprint/inputHash. Retirar autoridade de project.format/manifests[0]. |
| run-project-proxy-render-worker.ts / project-render-sources.ts | Revalidar exact version/state/spec/source SHA/probe/rights; materializar entrada. Identidade e formato em checks separados. |
| RenderablePlanSnapshot / readRenderableSnapshotSource | Binding explícito plano/entrada com planHash/projeção. Mesma versão sem mesmo plano não basta; sem binding bloquear. |
| run-project-final-export-worker.ts / repositório final | Mesma entrada/revisão da aprovação requerida; materializar reframe/placement no canvas final selado. Sem reconstruir ID/safe area por formato. |
| render-reframe-plan.ts, placement/compiler/port | Novo contrato com identidade/revisão/specHash e geometria/probe por fonte; sem preset mutable ou consultas no renderer. |
| Recipe/manifest/report/sidecar | Version/hash, state/hash, variant/revision/specHash, entry/dependency hash, RenderInput e MP4 SHA. Bump schema/recipe; artifact antigo não passa por input novo. |
| UI/Command W68 | Issue/reset/override opera variante/range/revisão/base exatos. Command não aprova issue; novo MP4/critic necessários. |

Render começa pelo FK da versão, valida corpo/referências seladas e verifica rights atuais. Revogação bloqueia uso sem reescrever snapshot. Nunca consultar ancestral, maior revisão, cabeça de overlay, versão corrente, project.format ou formato fallback para completar lacuna da versão solicitada.

Manifest/probe/normalização precisam descrever bytes materializados. Contradição, adulteração, fonte ausente, revisão não membro, state inexistente ou invalidation não resolvida bloqueiam antes de FFmpeg/publicação. Persistir reason code e escopo sem promover artifact. Lease/retry/cancel/cleanup continuam obrigatórios; retry usa contexto selado idêntico.

## 7. Migration e ordem proposta

1. Revisão owner/root antes de schema/runtime; reconciliar ADR/spec/API e limites do renderer, especialmente probe/orientação e múltiplas fontes. Aprovação documental não altera TODO.
2. Criar tabelas/relações/constraints; adicionar à Version discriminator de contrato e stateId/hash. Registros históricos continuam explicitamente não selados. Snapshots/baseHash antigos não são recalculados, nem outputs inferidos.
3. Migration identifica histórico como contrato 0 sem state. Inserções seguintes exigem contrato 1 com state/hash/FK; constraint/trigger de INSERT recusa contrato 0 para writer antigo não contornar gate. Novo default é 1. Contrato 0 é auditável/base do Command explícito; não renderizável no caminho novo.
4. Implementar helpers/domain/fingerprint/commit, adaptar todos os 15 builders/16 writers e hydrators. Baseline público usa OutputSpec explícito e source metadata observada.
5. Adaptar leitores/snapshot/proxy/final/compiler/recipe/artifacts/UI/API no mesmo slice coerente; bloquear render até cutover completo. Sem fallback histórico ou variante igual ao aspectRatio.
6. PG descartável local: bootstrap limpo, upgrade com histórico controlado, replay/rollback/CAS/FKs e cada writer; depois execução integrada da W66.

Schema isolado não prova integração. Histórico bloqueado expõe motivo/Command necessário. Reset/deploy remoto têm gates próprios do AGENTS e não pertencem a esta decisão.

## 8. Provas exigidas e rejeições

| Prova a construir/executar | Positivo | Negativo obrigatório |
| --- | --- | --- |
| Domínio/hash | Reconstrução determinística com IDs pré-alocados sem ciclo | Troca resultVersionId/state/revision/hash/escopo/campo materializado rejeita. Igualdade de formato não basta. |
| Duas irmãs 9:16 | A e B explícitas, spec/range iguais; crop A só afeta A | B com revision de A, replay A como B, render B com override/report A e cache por formato rejeitam. |
| Revisão OutputSpec | Rev2 de A gera filho; V1 conserva rev1; B conserva sua revisão | Ler V1 pela revisão mais recente ou transferir revisão para B falha. Canvas/fps alterados invalidam crop afetado. |
| Projeção | Texto/cor/áudio com geometria igual herdam crop/Command original | EditPlan hash diferente não invalida crop automaticamente; reorder com mesmo mapa por ID não herda. |
| Fontes/tempo/composição | Metadados observados coerentes preservam crop | SHA/manifest/dimensões/fps/orientação/rate/duração/scale/verticalPosition alterados invalidam; ausência/contradição bloqueia. |
| Ranges/reset | Range exato substitui, reset auditado, adjacente independente | Overlap parcial, range fora do clip, clip.crop global, geometria não suportada e overlay órfão rejeitam. |
| Todos writers | Cada linha com pai ativo e vazio | Omissão de transição falha integralmente. Ingest não apaga estado; anexo não usa inserção direta. |
| Restore/duplicação | Alvo exato restaurado; fork vazio com lineage | Ancestral ativo, IDs entre projetos e restore sem state fora do baseline explícito rejeitam. |
| PG/bootstrap | State→Version, CAS/replay/scope/unique reais | FK para outra versão/hash/workspace, duas revisões por entrada, INSERT contrato 0, rollback após State e CAS duplo: rejeição/zero resíduos. |
| Proxy/final runtime | API/PG/worker com entrada/revisão/manifests exatos | project.format/default/manifest recente, registry drift, bytes adulterados, rights revogados: bloqueio antes de publicar. |
| Visual | Pixels/ranges de A/B independentes, dois canvases, MP4/full decode/frames/critic | Crop manual não vira face-safe; falha A não aprova B; fixture não é aceite global. |
| API/segurança/observabilidade | Capability/contract tests, audit, errors/retry/cancel/lineage | Cross workspace, falsa provenance de detector, stale base/mismatch de ator não gravam; retry não troca fonte/spec. |

Fixtures/domínio verificam invariantes; PG verifica persistência; renderer real verifica aplicação; pixels/MP4/critic verificam resultado. Implementação isolada, integração, E2E, implantação e aceite continuam separados. W66 permanece parcial enquanto faltar integração ou prova necessária.

## 9. Decisão de contrato: `apollo.projects.create` 6.0.0 sem `format`

Decisão de Astra, 16/10/2026, registrada na integração da fundação W66. `POST /v1/projects` deixa de aceitar e de devolver `format`: a capability `apollo.projects.create` passa de 5.0.0 para **6.0.0** (major, breaking), com `create-project-request/v4` (obrigatórios `name` e `objective`) e `project-created/v5`. O formato pertence a cada OutputVariant e é criado por `apollo.projects.output-variants.create` 1.0.0 (`POST /v1/projects/{projectId}/output-variants`, `create-project-output-variant-request/v1` e `project-output-variant-created/v1`).

- **Sem fallback.** Não há alias, default `9:16`, campo opcional nem leitura de `project.format` para compatibilidade: a regra V2 proíbe contrato legado. Cliente que ainda envia `format` recebe rejeição de schema.
- **Baseline.** `contracts/v1/public-contract-baseline.json` e o relatório de paridade foram regenerados no mesmo commit: 386 para 387 capabilities e 684 para 688 schemas (v4, v5 e os dois do output variant). A mudança de versão com remoção de campo é declarada, não silenciosa.
- **Chamadores migrados (S2d).** Os testes de ponta a ponta e as ferramentas que criavam projeto com `format` (jornadas, provas do painel, semente de fonte, provas de transferência) agora criam o projeto sem formato e a saída como variante explícita sobre a Version de criação (`POST /v1/projects/{projectId}/output-variants`). Nada disso é empurrado ao PR #81.

## 10. Decisão de contrato: `apollo.projects.commands.apply` 10.0.0

Decisão de Astra, 16/10/2026. Duas correções do mesmo endpoint (`POST /v1/projects/{projectId}/commands`), registradas antes de qualquer push, num único major (9.0.0 para **10.0.0**).

- **`variantId` obrigatório em `remove-spoken-content`.** O corte editorial edita uma saída estável e o servidor nunca a infere do projeto (o serviço já exigia `variantId`), mas o schema publicado (`apply-project-edit-command-request/v6`) não o declarava e a rota rejeitava o campo como desconhecido. Entra `apply-project-edit-command-request/v7` (`variantId` obrigatório nessa ramificação, proibido em `replace-source-transcript` e `run-director`). Campo obrigatório novo é breaking: major.
- **A resposta não promete dado não selado.** `editorial.exclusions` passa a declarar só o que o Command sela e valida (`sourceStartSeconds`, `sourceEndSeconds`, `ruleIds`): `labels` e `matchedText` saem (não inventamos valor; a rota projeta explicitamente os três campos). Entra `project-edit-command-applied/v8`.
- **Sem fallback.** Não há aceitação de requisição sem `variantId` nem campo opcional de compatibilidade.
- **Baseline.** `contracts/v1/public-contract-baseline.json` e o relatório de paridade foram regenerados no mesmo commit: 688 para 690 schemas (request v7 e response v8); capabilities seguem 387. Chamadores e testes de ponta a ponta que enviam `remove-spoken-content` foram atualizados para informar `variantId`.

## 11. Decisão de modelo: um filho adota os recibos persistidos das outras gravações do projeto

Decisão de Astra, 17/10/2026 (S2c). O State3 guarda a observação de um ingest só (a do último), mas cada ingest persistiu o seu próprio recibo. Um Command cujo plano consome várias gravações (corte multicâmera, inserção selecionada, música, troca de asset) ficava sem Version possível, o que regredia uma capacidade entregue e coberta pela CI. Recusar não é aceitável; o modelo passa a ser:

- **Adoção, não cópia.** A origem `child-command` declara `adoptions` (ordenadas por recibo, sem repetição): para cada recibo adotado, o id e o selo do recibo, o artifact/manifest/selo do manifest que ele observou e os direitos sob os quais foi adotado (snapshot, hash, revisão). Elas são exatamente as observações das materializações que o State pai não tinha e fazem parte do producer do State, portanto do hash da Version.
- **Fail-closed.** Só recibo do mesmo workspace e projeto, persistido, íntegro (`w66_assert_normalization_v3`), com direitos correntes, e só para fonte que o novo plano consome e o pai não observa. Fonte sem recibo recusa o Command nomeando o artifact (`PRECONDITION_REQUIRED`); recibo de outro escopo, selo adulterado ou dois recibos para a mesma fonte recusam (`INVALID_COMMAND`, `INVALID_RENDER_INPUT`); fonte sem direitos correntes é `ASSET_RIGHTS_BLOCKED`. Nunca um artifact não observado.
- **Direitos.** A leitura registra a evidência (snapshot, hash, revisão). No commit os artifacts são travados em ordem C, os recibos relidos e a evidência comparada (`VERSION_CONFLICT` se mudou); depois roda a política de uso do asset. O guard SQL repete, no COMMIT, recibo persistido do projeto, validade factual, vínculo com o projeto e direitos aprovados, não expirados e iguais aos adotados.
- **Leitura sob demanda.** Os repositórios só leem recibos para as fontes que o plano consome e o pai não observa; um Command que não adiciona fonte não paga leitura.
- **Escopo de adoção.** Multicâmera, Director (inserções e música), manual-edit apply (troca de asset) e patches de revisão. Restore, undo/redo, select, fork e corte editorial continuam exigindo exatamente as observações do alvo.
- **Execução.** A migration `20261016120000_project_child_command_state_v1` e a suíte `project-child-adoption.pg.integration.mjs` rodaram contra PostgreSQL 16 sob o supervisor local (S2d); os casos de adoção, de direitos movidos no meio da transação e de reuso de veredito passam. O guard não repete o veredito de um mesmo State dentro de uma mesma sentença e de um mesmo conjunto de escritas (veja §12).

## 12. Higiene de dados de teste no mundo selado (S2d)

Decisão de Astra, 17/10/2026. Linhas seladas são apêndice-só: os gatilhos `w66_output_immutable` e `w66_output_dependency_guard` recusam UPDATE e DELETE em `project_versions`, nas tabelas `output_*`, em `edit_commands`, `project_creation_commands`, `project_snapshots`, `renderable_plan_snapshots`, `media_ingest_operations`, `media_artifact_manifests`, `media_transcripts` e nas `public_operations` de ingest, e o delete de um workspace cascateia para dentro deles. Consequências para qualquer suíte PG ou de ponta a ponta:

- **Sem limpeza por delete.** Os gatilhos não são desligados, removidos nem contornados. A regra é identidade única por execução (`uniqueRun`, `randomUUID`) e asserções limitadas a essas identidades. Uma suíte que nomeia as suas identidades (por exemplo `public-project-api.integration.mjs`) é de uso único por banco e diz isso na primeira asserção, em vez de falhar adiante numa constraint.
- **Zerar o banco só por TRUNCATE, só por um helper.** `tests/v2/helpers/disposable-database.mjs` (`resetDisposableDatabase`) executa `TRUNCATE TABLE "workspaces" CASCADE` e recusa rodar se o nome do banco não tiver a palavra `e2e`, se o `application_name` da conexão não começar por `apollo-video-e2e-` ou se o servidor não for local. TRUNCATE não aciona os gatilhos de linha, e uma prova PG supervisionada do helper mostra que não existe gatilho de TRUNCATE nem de evento no schema. Jobs de CI que usam o banco `apollo_v2` não podem chamar o helper e usam identidades únicas.
- **Adulteração por UPDATE é impossível, por desenho.** Um teste que corrompia manifest, snapshot ou Command para provar que o leitor detecta corrupção passa a inserir a contradição no INSERT (a inserção é permitida: linha nova para o mesmo artifact e reapontamento das linhas mutáveis que o referenciam) ou aposenta o negativo e cita o gatilho que o torna inalcançável.
- **Versions nascem seladas.** Nenhuma suíte insere `ProjectVersion` na mão. O mundo de teste (`tests/v2/helpers/pg-output-world.mjs`) usa os repositórios do produto: criação (raiz, contrato 2), variante explícita (contrato 3), `persistRecording` / `persistReceiptForExistingVideo` (artifact, manifest, operação de ingest, recibo e direitos) e `commitSealedChild` (um filho real que adota os recibos).
- **O Prisma 5.22 engole a recusa do COMMIT.** Uma transação interativa resolve mesmo quando um gatilho deferido recusa o COMMIT. Todo escritor de Version termina a transação com `SET CONSTRAINTS ALL IMMEDIATE` (`settleDeferredOutputGuards`); uma prova PG supervisionada demonstra o comportamento e `version-commit-settles-guards.test.mjs` impede um escritor novo de omitir o passo.
- **Moeda de direitos por `xmin`.** O guard de State considera "escrito nesta transação" a linha cujo `xmin` é o `txid_current()`; a versão anterior (profundidade de gatilho) congelava um projeto depois que os direitos se moviam. Um veredito já aprovado é reaproveitado só para o mesmo State, na mesma sentença e com o mesmo número de linhas escritas (`pg_stat_xact_all_tables`), e nunca com `track_counts` desligado.
- **Transações de escrita de 30 s.** O guard relê todos os recibos do State; o default de 5 s do Prisma derrubava um corte multicâmera de duas gravações curtas.
- **Formato de um projeto 6.0.0.** `projects.format` é nulo. Os fluxos de saída única leem o formato do único output explícito do State (`projectOutputFormat` com o bundle na mão, `resolveProjectOutputFormat` sem ele); com vários outputs não há formato único e o chamador recusa em vez de adivinhar. O faceta `format` da listagem filtra o formato do próprio projeto e não encontra um projeto 6.0.0: decidir se ela passa a olhar os outputs é decisão de contrato.
- **Ingest deixa uma operação.** Um projeto cuja fonte foi ingerida tem uma operação `media-ingest` concluída, e é ela a "última operação" do cartão do painel. Provas de painel não fingem um rascunho sem operação.
- **Ingest devolve o projeto a `draft`.** O escritor operacional de uma origem `ingest-operation` move a cabeça e, no mesmo UPDATE (com a trilha de status `ingesting` para `draft` como condição), tira o projeto de `ingesting`. Medido sob o supervisor: sem isso o projeto ficava em `ingesting` e a admissão do render de proxy recusava (`PROJECT_TRANSITION_REJECTED`).
- **O State lista as observações herdadas antes das adotadas.** A reconstrução fatual relê os recibos na ordem do State, não na ordem em que o banco os devolve; um recibo adotado cujo id ordena antes do herdado só se lê de volta assim (provado por um caso de PG da adoção).
- **Uma fonte ingerida já é revisável.** Ela traz o proxy de edição que a sessão de anotação pré-visualiza; o painel e a disponibilidade de revisão a tratam assim, e uma prova de painel que precise de um "rascunho sem revisão" usa um projeto sem mídia.
- **Identidades fixas.** Jornadas e provas que nomeiam as suas identidades (captura, API pública) são de uso único por banco e dizem isso na primeira asserção.

## 13. Decisão de modelo: uma cópia aceita Commands de configuração antes do corte editorial

Decisão de Astra, 17/10/2026 (S2d). Uma cópia de um projeto com conteúdo é um Creation fork (contrato 2, State `fork-with-content`): ela não tem autoridade de transcript, percepção nem geometria no alvo até que um corte editorial (`remove-spoken-content`) ligue ao alvo as observações da derivation do fork. Até aqui toda Command filha era recusada nesse intervalo. Agora:

- **O que a cópia aceita como filho.** Os Commands que só configuram o que foi copiado: `set-project-lut-selection`, `set-project-color-plan`, `set-project-subtitle-mode`, `apply-subtitle-segment-override` e `set-project-policy-overrides` (`FORK_INHERITABLE_COMMAND_TYPES`). O filho herda a postura do fork: o plano é preservado byte a byte sob a identidade nova, nenhuma gravação é observada, adotada nem materializada, a revisão literal do fork (`output-spec-revision/v3`) é mantida e toda entrada do State3 fica `blocked` com o motivo `fork-target-materialization-required` (`forkAuthorityPendingV3`). Os filhos encadeiam. Só `set-project-policy-overrides` substitui um snapshot (policies).
- **O corte editorial continua possível depois deles.** A autoridade do corte é a derivation do Creation fork (primeira Version do projeto), não o filho de configuração: `forkRoot` entra na proposta do corte, o builder valida o par fork-root/derivation e a binding nomeia `forkRootVersionId` do fork. Configurar uma cópia nunca a deixa sem saída.
- **O que a cópia continua recusando.** Variante nova, edição manual, patch de revisão, troca de transcript, Director, multicâmera e anexo de biblioteca recusam com `PRECONDITION_REQUIRED` e `details.reason = copy-requires-editorial-cut`. O mesmo vale para renderizar, exportar e anotar uma cópia sem corte (`requireCopyTargetAuthority`, em `proxy-source-authority.ts` e na criação de anotação). O erro público publica só esse motivo fechado (`error-presenter.ts`); a página do projeto o mostra como mensagem ao operador. As rotas de LUT e ColorPlan respondem 201 sem `operation` quando o Command foi gravado numa cópia sem corte: o render espera o corte.
- **Banco.** Migration `20261017120000_fork_copy_configuration_children_v1`: `CREATE OR REPLACE` de `w66_assert_child_command_state_v1` (o pai pode ser o fork ou um State3 todo `blocked` com o motivo do fork; só os cinco tipos, sem adoções, sem materialização; fora desse caso a regra anterior fica intacta) e de `w66_assert_editorial_binding_v1` (o pai pode ser um filho de configuração, com autoridade `fork-derivation3`), mais a função auxiliar `w66_fork_copy_pending_v1`. Nenhum gatilho de imutabilidade é tocado.
- **Formato da cópia.** `projectOutputFormat` / `resolveProjectOutputFormat` leem o aspect ratio da revisão literal do fork (`effectiveSpec`); sem isso nenhum fluxo de saída única (LUT, ColorPlan, render) achava formato numa cópia.
- **Provas.** Puras: `project-output-state-transition.test.mjs` (cinco tipos, encadeamento, recusas com o motivo, observação/adoção/materialização escondidas, texto do guard SQL), `apply-editorial-cut-command.test.mjs` (corte sobre cópia só configurada), `project-output-format.test.mjs`, `public-contracts.test.mjs`. PG: `project-operational-output-bundle.pg.integration.mjs` (fork, LUT, LUT, variante recusada, corte editorial, leitura de volta) e `prisma-project-duplication.integration.mjs` (LUT e policy override na cópia por HTTP, State bloqueado, `output-variants` e `proxy-renders` recusados com o motivo, cópia da cópia).

### Lacunas nomeadas (não são desta decisão)

1. **Cópia renderizável logo após um Command de configuração (materialização pela derivation do fork).** Hoje a cópia só renderiza depois do corte editorial. Materializar a cópia direto pela derivation exigiria uma binding de autoridade no próprio filho de configuração e a réplica do guard editorial no guard do filho; não foi feito.
2. **Filhos depois do corte.** Depois do corte editorial as entradas da cópia mantêm a revisão literal do fork; um filho que recompila ou rematerializa (LUT, patch de revisão, edição manual) é recusado pelo builder com `PRECONDITION_REQUIRED` ("Non-editorial child requires its declared revision contract"). Só outro corte editorial é admitido.
3. **Cópia de projeto planejado pelo Director.** O plano do Director não traz `retimedTranscript.sourceTranscriptHash` nem a linha de tempo de palavras alinhadas que o corte exige; uma cópia desse projeto aceita configuração, mas não alcança o corte. O corte é provado sobre planos compilados pelo ingest.
4. **Consumo.** `readPersistedOutputConsumptionV3` continua respondendo `blocked` (`derived-source-perception-authority-required`) para toda cópia cortada, em todo propósito; a admissão de render usa o corte como autoridade e não essa leitura.

**Texto de bloqueio para o project-status (W66, sem mudança de estado):** "Cópia de projeto (fork) aceita Commands de configuração antes do corte editorial e recusa render/export/revisão com `copy-requires-editorial-cut`. Pendentes: (a) cópia renderizável logo após Command de configuração (materialização pela derivation do fork); (b) filhos de uma cópia depois do corte (LUT, patch, edição manual) recusados pelo builder; (c) cópia de projeto do Director não alcança o corte (plano sem `sourceTranscriptHash`)."

## 14. Correções de produto encontradas pela migração dos testes (S2d)

- **Trim e split de um clip trocado (`replace`).** O clip mantém uma faixa de áudio própria (`audioSourceInFrame/OutFrame`); trim e split moviam a imagem e a linha de tempo mas não essa faixa, e a materialização selada recusava o clip (`Primary/secondary audio rate map invalid`). Agora deslocam a faixa de áudio pelo mesmo trecho de fonte. Teste puro em `manual-render-workflow.test.mjs`; PG em `prisma-manual-edit.integration.mjs`.
- **Identidades de captura, sync e protocolo por workspace.** Ids como `<trackId>:coverage` eram globais: o segundo workspace colidia na chave primária ou, onde o writer faz upsert por id, tomava a linha do primeiro. O id passa a ser um digest do workspace e das partes naturais (`scoped-row-id.ts`); os leitores já buscavam por workspace e chave natural, então linhas antigas continuam legíveis e são reescritas no lugar. Sem migration. Pendente de decisão (precisaria de migration): marcadores de sync ainda têm `markerId` como chave primária global, e a cobertura é única por workspace e track, não por sessão.
- **Export final com legendas.** O worker do export final passava os cues ao renderer sem o plano de posicionamento que o renderer exige para eles, então um final com legendas nunca era admitido. Os dois workers (proxy e final) derivam cues, CTAs, plano de posicionamento e de reframe pela mesma função (`derive-editorial-render-geometry.ts`); só o canvas difere. O gate do renderer não mudou; com rosto desconhecido a política suprime os cues (no proxy também), então o final é admitido mas não desenha legenda.
